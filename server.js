// server.js
// Prototipo "Cerca" — conecta con alguien cuando ambos estan fisicamente cerca.
// Sin dependencias externas: usa solo modulos nativos de Node
// (http, fs, path, crypto) + lib/mini-ws.js (implementacion minima de WebSocket).
//
// Para produccion real se recomendaria usar "express" + "ws" (mas robustos y
// mantenidos), pero este entorno de pruebas no tiene acceso a npm, asi que
// el prototipo es 100% Node core. Correrlo es simplemente: node server.js
//
// Protocolo (JSON sobre WebSocket):
//
//   Cliente -> Servidor
//     { type: "join", name, emoji, bio, lookingFor }
//     { type: "location", lat, lng }
//     { type: "visibility", visible: true|false }
//     { type: "radius", meters }
//     { type: "like", targetId }
//     { type: "unlike", targetId }
//     { type: "block", targetId }
//     { type: "chat", targetId, text }
//
//     --- Juego de fiesta "Verdad o Reto" (18+, sala independiente por codigo) ---
//     { type: "room:create", intensity }
//     { type: "room:join", code }
//     { type: "room:leave" }
//     { type: "room:setIntensity", intensity }
//     { type: "room:start" }          // solo el host
//     { type: "room:spin" }           // solo el host
//     { type: "room:choice", choice } // "truth" | "dare", solo el jugador seleccionado
//     { type: "room:pass" }           // solo el jugador seleccionado
//     { type: "room:next" }           // host o jugador seleccionado
//
//   Servidor -> Cliente
//     { type: "welcome", id }
//     { type: "nearby", users: [{ id, name, emoji, bio, lookingFor, distanceMeters, distanceLabel, liked, matched }] }
//     { type: "match", id, name, emoji }
//     { type: "chat", from, text, ts, self? }
//     { type: "room:state", code, hostId, intensity, phase, players, selectedId, choice, prompt }
//     { type: "room:error", message }
//     { type: "error", message }
//
// Nota de privacidad: el servidor NUNCA envia lat/lng de un usuario a otro.
// Solo se comparte una distancia aproximada (redondeada) y, cuando hay match
// mutuo, se habilita el chat.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, OPEN } = require("./lib/mini-ws");
const { createGameModule } = require("./lib/party-game");

const PORT = process.env.PORT || 3000;
const STATIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(STATIC_DIR, urlPath));
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 - No encontrado");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer(server);

/** @type {Map<string, Client>} */
const clients = new Map();

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Redondea la distancia para no revelar precision excesiva (proteccion de privacidad).
function roundDistance(meters) {
  if (meters < 30) return { meters: 20, label: "muy cerca (~20 m)" };
  if (meters < 100) {
    const m = Math.round(meters / 10) * 10;
    return { meters: m, label: `~${m} m` };
  }
  if (meters < 1000) {
    const m = Math.round(meters / 50) * 50;
    return { meters: m, label: `~${m} m` };
  }
  const km = Math.round((meters / 1000) * 10) / 10;
  return { meters: Math.round(meters), label: `~${km} km` };
}

function send(ws, obj) {
  if (ws.readyState === OPEN) ws.send(JSON.stringify(obj));
}

const gameModule = createGameModule({ clients, send });

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  const client = {
    id,
    ws,
    profile: null, // { name, emoji, bio, lookingFor }
    lat: null,
    lng: null,
    visible: false,
    radius: 500, // metros, por defecto
    likes: new Set(), // a quien le di like
    blocked: new Set(),
    matches: new Set(), // ids con match confirmado
    roomCode: null, // sala del juego "Verdad o Reto" en la que esta, si alguna
  };
  clients.set(id, client);
  send(ws, { type: "welcome", id });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { type: "error", message: "JSON invalido" });
    }
    handleMessage(client, msg);
  });

  ws.on("close", () => {
    gameModule.leaveRoom(client);
    clients.delete(id);
  });

  ws.on("error", () => {
    gameModule.leaveRoom(client);
    clients.delete(id);
  });
});

function handleMessage(client, msg) {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type.startsWith("room:")) return gameModule.handle(client, msg);
  switch (msg.type) {
    case "join": {
      const interests = Array.isArray(msg.interests)
        ? [...new Set(msg.interests.map((s) => String(s).slice(0, 30)))].slice(0, 12)
        : [];
      client.profile = {
        name: String(msg.name || "Anonimo").slice(0, 40),
        emoji: String(msg.emoji || "🙂").slice(0, 8),
        bio: String(msg.bio || "").slice(0, 140),
        lookingFor: String(msg.lookingFor || "").slice(0, 60),
        interests,
      };
      break;
    }
    case "location": {
      if (typeof msg.lat === "number" && typeof msg.lng === "number") {
        client.lat = msg.lat;
        client.lng = msg.lng;
      }
      break;
    }
    case "visibility": {
      client.visible = !!msg.visible;
      break;
    }
    case "radius": {
      const r = Number(msg.meters);
      if (!Number.isNaN(r)) client.radius = Math.min(Math.max(r, 20), 5000);
      break;
    }
    case "like": {
      const target = clients.get(msg.targetId);
      if (!target || target.id === client.id) return;
      client.likes.add(target.id);
      if (target.likes.has(client.id)) {
        client.matches.add(target.id);
        target.matches.add(client.id);
        send(client.ws, { type: "match", id: target.id, name: target.profile?.name, emoji: target.profile?.emoji });
        send(target.ws, { type: "match", id: client.id, name: client.profile?.name, emoji: client.profile?.emoji });
      }
      break;
    }
    case "unlike": {
      client.likes.delete(msg.targetId);
      break;
    }
    case "block": {
      client.blocked.add(msg.targetId);
      client.matches.delete(msg.targetId);
      const target = clients.get(msg.targetId);
      if (target) target.matches.delete(client.id);
      break;
    }
    case "chat": {
      const target = clients.get(msg.targetId);
      if (!target) return send(client.ws, { type: "error", message: "Usuario no disponible" });
      if (!client.matches.has(target.id) || !target.matches.has(client.id)) {
        return send(client.ws, { type: "error", message: "Solo puedes chatear con un match" });
      }
      const text = String(msg.text || "").slice(0, 500);
      if (!text) return;
      const ts = Date.now();
      send(target.ws, { type: "chat", from: client.id, text, ts });
      send(client.ws, { type: "chat", from: client.id, text, ts, self: true });
      break;
    }
    default:
      send(client.ws, { type: "error", message: "Tipo de mensaje desconocido" });
  }
}

// Recalcula y difunde la lista de "cerca" a cada cliente visible y con ubicacion.
function broadcastNearby() {
  const all = [...clients.values()];
  for (const viewer of all) {
    if (!viewer.visible || viewer.lat == null || viewer.lng == null || !viewer.profile) continue;
    const nearby = [];
    for (const other of all) {
      if (other.id === viewer.id) continue;
      if (!other.visible || other.lat == null || other.lng == null || !other.profile) continue;
      if (viewer.blocked.has(other.id) || other.blocked.has(viewer.id)) continue;
      const meters = haversineMeters(viewer.lat, viewer.lng, other.lat, other.lng);
      if (meters > viewer.radius) continue;
      const dist = roundDistance(meters);
      const viewerInterests = viewer.profile.interests || [];
      const otherInterests = other.profile.interests || [];
      const sharedInterests = viewerInterests.filter((i) => otherInterests.includes(i));
      nearby.push({
        id: other.id,
        name: other.profile.name,
        emoji: other.profile.emoji,
        bio: other.profile.bio,
        lookingFor: other.profile.lookingFor,
        interests: otherInterests,
        sharedInterests,
        distanceMeters: dist.meters,
        distanceLabel: dist.label,
        liked: viewer.likes.has(other.id),
        matched: viewer.matches.has(other.id) && other.matches.has(viewer.id),
      });
    }
    nearby.sort((a, b) => a.distanceMeters - b.distanceMeters);
    send(viewer.ws, { type: "nearby", users: nearby });
  }
}

setInterval(broadcastNearby, 1500);

server.listen(PORT, () => {
  console.log(`Cerca app escuchando en http://localhost:${PORT}`);
});
