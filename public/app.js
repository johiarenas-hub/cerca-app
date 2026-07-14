// app.js — cliente del prototipo "Cerca"

const EMOJIS = ["🙂","😎","🌟","🔥","🌈","🎧","📚","🏃","🎨","🍕","☕","🐾","🌻","⚡","🎸","✨"];

const INTERESTS = [
  "☕ Café", "🥾 Senderismo", "🎵 Música", "📚 Lectura", "🎮 Videojuegos",
  "🍳 Cocina", "🐾 Mascotas", "✈️ Viajar", "🏋️ Gym", "🎨 Arte",
  "🎬 Cine", "⚽ Deporte", "🧘 Yoga", "🍷 Vino", "📷 Fotografía",
  "🌱 Naturaleza", "💃 Bailar", "🛠️ DIY",
];
const MAX_INTERESTS = 6;

const TOKEN_KEY = "cerca_token_v1";
const PROFILE_KEY = "cerca_profile_v1";

// El token identifica "este navegador/pestaña" de forma estable entre
// recargas, para que al volver no se borre el perfil ni los matches ya
// confirmados (el servidor no tiene base de datos: usa este token para
// reconocerte al reconectar).
function getOrCreateToken() {
  try {
    let token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      token = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(TOKEN_KEY, token);
    }
    return token;
  } catch {
    return null; // localStorage no disponible (modo privado estricto, etc.)
  }
}

function saveProfile(profile) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    /* si no hay localStorage, simplemente no se recuerda entre visitas */
  }
}

function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSavedSession() {
  try {
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nada que limpiar */
  }
}

const state = {
  ws: null,
  id: null,
  profile: null,
  visible: false,
  radius: 500,
  usingRealGeo: false,
  watchId: null,
  nearby: [],
  matches: new Map(), // id -> {id,name,emoji}
  activeChatId: null,
  selectedEmoji: EMOJIS[0],
  selectedInterests: new Set(),
  notifiedInterestIds: new Set(), // ids ya notificados por interes en comun (evita spam)
  // --- Juego "Verdad o Reto" ---
  gameConsent: false,
  createIntensity: "suave",
  room: null, // ultimo "room:state" recibido del servidor
  lastPhase: null,
};

const $ = (sel) => document.querySelector(sel);

// ---------- Onboarding ----------

function renderEmojiPicker() {
  const wrap = $("#emoji-picker");
  wrap.innerHTML = "";
  EMOJIS.forEach((e) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = e;
    if (e === state.selectedEmoji) btn.classList.add("selected");
    btn.addEventListener("click", () => {
      state.selectedEmoji = e;
      renderEmojiPicker();
    });
    wrap.appendChild(btn);
  });
}
renderEmojiPicker();

function renderInterestsPicker() {
  const wrap = $("#interests-picker");
  wrap.innerHTML = "";
  INTERESTS.forEach((label) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    const selected = state.selectedInterests.has(label);
    if (selected) btn.classList.add("selected");
    if (!selected && state.selectedInterests.size >= MAX_INTERESTS) btn.disabled = true;
    btn.addEventListener("click", () => {
      if (state.selectedInterests.has(label)) {
        state.selectedInterests.delete(label);
      } else if (state.selectedInterests.size < MAX_INTERESTS) {
        state.selectedInterests.add(label);
      }
      renderInterestsPicker();
    });
    wrap.appendChild(btn);
  });
}
renderInterestsPicker();

function startWithProfile(profile, opts) {
  opts = opts || {};
  state.profile = profile;

  $("#me-avatar").textContent = profile.emoji;
  $("#me-name").textContent = profile.name;
  $("#match-avatar-me").textContent = profile.emoji;

  if (!opts.skipSave) saveProfile(profile);

  requestNotificationPermission();
  showScreen("main");
  connect();
  startLocation();
}

$("#btn-start").addEventListener("click", () => {
  const name = $("#name").value.trim() || "Anónimo";
  const bio = $("#bio").value.trim();
  const lookingFor = $("#lookingFor").value.trim();
  const interests = [...state.selectedInterests];
  startWithProfile({ name, emoji: state.selectedEmoji, bio, lookingFor, interests });
});

$("#btn-edit-profile").addEventListener("click", () => {
  if (!confirm("¿Cambiar de perfil? Se cerrará esta sesión (perfil, matches y sala del juego) y empezarás de cero.")) return;
  clearSavedSession();
  location.reload();
});

function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

// Muestra una notificación del sistema (si hay permiso) ademas del toast en pantalla.
function notifyUser(title, body) {
  showToast(`${title} — ${body}`);
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, { body, icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%93%8D%3C/text%3E%3C/svg%3E" });
    } catch {
      /* algunos navegadores en movil no soportan "new Notification" directamente */
    }
  }
}

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(`#screen-${name}`).classList.add("active");
}

// ---------- WebSocket ----------

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const token = getOrCreateToken();
  const url = token ? `${proto}://${location.host}/?token=${encodeURIComponent(token)}` : `${proto}://${location.host}`;
  state.ws = new WebSocket(url);

  state.ws.addEventListener("open", () => {
    const wasReconnecting = reconnectAttempts > 0;
    reconnectAttempts = 0;
    send({ type: "join", ...state.profile });
    send({ type: "visibility", visible: state.visible });
    send({ type: "radius", meters: state.radius });
    if (wasReconnecting) setLocationStatus("Reconectado ✓");
  });

  state.ws.addEventListener("message", (evt) => {
    const msg = JSON.parse(evt.data);
    handleServerMessage(msg);
  });

  state.ws.addEventListener("close", () => {
    if (!state.profile) return; // cierre antes de haber entrado (no hay nada que reconectar)
    setLocationStatus("Conexión perdida. Reconectando…", true);
    scheduleReconnect();
  });
}

let reconnectTimer = null;
let reconnectAttempts = 0;

// Reconecta solo automáticamente (sin recargar la página) si se cae la
// conexión mientras la app ya estaba en uso — por ejemplo al volver de
// segundo plano en el móvil. Gracias al token guardado, el servidor
// reconoce que eres la misma persona y no pierdes tu perfil ni tus matches.
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 15000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempts++;
    connect();
  }, delay);
}

function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case "welcome":
      state.id = msg.id;
      if (Array.isArray(msg.matches) && msg.matches.length) {
        msg.matches.forEach((m) => {
          if (!state.matches.has(m.id)) state.matches.set(m.id, m);
        });
        renderMatches();
      }
      break;
    case "nearby":
      state.nearby = msg.users;
      renderNearby();
      renderRadar();
      checkInterestNotifications(msg.users);
      break;
    case "match": {
      state.matches.set(msg.id, { id: msg.id, name: msg.name, emoji: msg.emoji });
      renderMatches();
      showMatchCelebration({ id: msg.id, name: msg.name, emoji: msg.emoji });
      break;
    }
    case "chat": {
      appendChatMessage(msg);
      break;
    }
    case "room:state": {
      state.room = msg;
      renderGame();
      break;
    }
    case "room:error": {
      const errBox = $("#game-home-error");
      if (errBox) {
        errBox.textContent = msg.message;
        errBox.style.display = "block";
      }
      showToast(msg.message);
      break;
    }
    case "error":
      console.warn("Error del servidor:", msg.message);
      break;
  }
}

// ---------- Ubicación ----------

function setLocationStatus(text, isWarning) {
  const el = $("#location-status");
  el.textContent = text;
  el.style.borderColor = isWarning ? "#ff5e7e" : "";
}

function startLocation() {
  if (!("geolocation" in navigator)) {
    setLocationStatus("Tu navegador no soporta geolocalización. Usa el modo simulación de abajo.", true);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    () => {
      state.usingRealGeo = true;
      state.watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 10000,
      });
      setLocationStatus("Ubicación real activada. Activa visibilidad para que otros te vean.");
      setVisible(true);
    },
    onGeoError,
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function onGeoError() {
  setLocationStatus(
    "No se pudo obtener tu ubicación real (permiso denegado o no disponible). Usa el modo simulación de abajo para probar.",
    true
  );
}

function onPosition(pos) {
  send({ type: "location", lat: pos.coords.latitude, lng: pos.coords.longitude });
}

$("#btn-sim-apply").addEventListener("click", () => {
  const lat = parseFloat($("#sim-lat").value);
  const lng = parseFloat($("#sim-lng").value);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    showToast("Introduce una latitud y longitud válidas.");
    return;
  }
  if (state.usingRealGeo && state.watchId != null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.usingRealGeo = false;
  }
  send({ type: "location", lat, lng });
  setLocationStatus(`Ubicación simulada activa: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  setVisible(true);
});

// ---------- Visibilidad y radio ----------

function setVisible(v) {
  state.visible = v;
  send({ type: "visibility", visible: v });
  const pill = $("#visibility-pill");
  pill.textContent = v ? "● Visible" : "● Invisible";
  pill.className = "pill " + (v ? "on" : "off");
}

$("#visibility-pill").addEventListener("click", () => setVisible(!state.visible));

$("#radius").addEventListener("input", (e) => {
  state.radius = Number(e.target.value);
  $("#radius-label").textContent =
    state.radius >= 1000 ? `${(state.radius / 1000).toFixed(1)} km` : `${state.radius} m`;
  send({ type: "radius", meters: state.radius });
});

// ---------- Tabs ----------

$("#tab-nearby").addEventListener("click", () => switchTab("nearby"));
$("#tab-matches").addEventListener("click", () => switchTab("matches"));

function switchTab(tab) {
  $("#tab-nearby").classList.toggle("active", tab === "nearby");
  $("#tab-matches").classList.toggle("active", tab === "matches");
  $("#view-nearby").style.display = tab === "nearby" ? "block" : "none";
  $("#view-matches").style.display = tab === "matches" ? "flex" : "none";
}

// ---------- Render: lista de cercanos ----------

function renderNearby() {
  const list = $("#nearby-list");
  if (state.nearby.length === 0) {
    list.innerHTML = `<div class="empty">Nadie visible cerca todavía. Prueba a ampliar el radio o comprueba que tu ubicación esté activa.</div>`;
    return;
  }
  list.innerHTML = "";
  state.nearby.forEach((u) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="avatar">${u.emoji}</div>
      <div class="info">
        <div class="row1">
          <span class="name">${escapeHtml(u.name)}</span>
          <span class="dist">${u.distanceLabel}</span>
        </div>
        ${u.bio ? `<div class="bio">${escapeHtml(u.bio)}</div>` : ""}
        ${u.lookingFor ? `<div class="looking">Busca: ${escapeHtml(u.lookingFor)}</div>` : ""}
        ${
          u.sharedInterests && u.sharedInterests.length
            ? `<div class="shared-interests">${u.sharedInterests.map((i) => `<span class="tag">${escapeHtml(i)}</span>`).join("")}</div>`
            : ""
        }
        ${u.matched ? `<div class="badge-match">✔ Match — podéis chatear</div>` : ""}
      </div>
      <div class="actions">
        <button class="iconbtn like ${u.liked ? "liked" : ""}" data-id="${u.id}">
          ${u.liked ? "💜 Interesa" : "🤍 Me interesa"}
        </button>
        <button class="iconbtn block" data-id="${u.id}">Bloquear</button>
      </div>
    `;
    card.querySelector(".like").addEventListener("click", () => {
      send({ type: "like", targetId: u.id });
    });
    card.querySelector(".block").addEventListener("click", () => {
      if (confirm(`¿Bloquear a ${u.name}? No podrá verte ni contactarte.`)) {
        send({ type: "block", targetId: u.id });
      }
    });
    list.appendChild(card);
  });
}

function renderRadar() {
  const radar = $("#radar");
  radar.querySelectorAll(".radar-dot, .radar-ring").forEach((el) => el.remove());

  [0.33, 0.66, 1].forEach((f) => {
    const ring = document.createElement("div");
    ring.className = "radar-ring";
    const size = f * 100;
    ring.style.width = size + "%";
    ring.style.height = size + "%";
    ring.style.top = (100 - size) / 2 + "%";
    ring.style.left = (100 - size) / 2 + "%";
    radar.appendChild(ring);
  });

  if (state.nearby.length === 0) return;
  const maxDist = Math.max(...state.nearby.map((u) => u.distanceMeters), 1);

  state.nearby.forEach((u) => {
    const dot = document.createElement("div");
    dot.className = "radar-dot" + (u.matched ? " matched" : "");
    dot.textContent = u.emoji;
    dot.title = `${u.name} — ${u.distanceLabel}`;

    // Angulo pseudo-aleatorio pero estable (deriva del id), NO es direccion real —
    // solo se usa la distancia real, por privacidad.
    const angle = hashToAngle(u.id);
    const r = 0.15 + 0.75 * (u.distanceMeters / maxDist); // radio relativo dentro del circulo
    const x = 50 + r * 42 * Math.cos(angle);
    const y = 50 + r * 42 * Math.sin(angle);
    dot.style.left = x + "%";
    dot.style.top = y + "%";
    dot.addEventListener("click", () => send({ type: "like", targetId: u.id }));
    radar.appendChild(dot);
  });
}

// Notifica (una sola vez por persona) cuando alguien cercano comparte intereses contigo.
function checkInterestNotifications(users) {
  users.forEach((u) => {
    if (!u.sharedInterests || u.sharedInterests.length === 0) return;
    if (state.notifiedInterestIds.has(u.id)) return;
    state.notifiedInterestIds.add(u.id);
    const first = u.sharedInterests[0];
    const extra = u.sharedInterests.length - 1;
    const detail = extra > 0 ? `${first} y ${extra} más en común` : `${first} en común`;
    notifyUser(`🎯 ${u.emoji} ${u.name} está cerca`, `Tenéis ${detail} — ${u.distanceLabel}`);
  });
}

function hashToAngle(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return (h % 360) * (Math.PI / 180);
}

// ---------- Render: matches ----------

function renderMatches() {
  const list = $("#matches-list");
  if (state.matches.size === 0) {
    list.innerHTML = `<div class="empty">Aún no tienes matches. ¡Dale "Me interesa" a alguien cercano!</div>`;
    return;
  }
  list.innerHTML = "";
  [...state.matches.values()].forEach((m) => {
    const row = document.createElement("div");
    row.className = "match-row";
    row.innerHTML = `<span class="avatar">${m.emoji}</span><span class="name">${escapeHtml(m.name)}</span><span>💬</span>`;
    row.addEventListener("click", () => openChat(m));
    list.appendChild(row);
  });
}

// ---------- Celebración de match ----------

let pendingMatch = null;
const CONFETTI_COLORS = ["#c9992e", "#8a6a1f", "#e8c873", "#fff6df", "#2f8f5b"];

function showMatchCelebration(match) {
  pendingMatch = match;
  $("#match-avatar-them").textContent = match.emoji;
  $("#match-text").textContent = `Tú y ${match.name} os habéis dado "me interesa" mutuamente.`;
  spawnConfetti();
  $("#match-overlay").classList.add("active");
}

function hideMatchCelebration() {
  $("#match-overlay").classList.remove("active");
  $("#match-confetti").innerHTML = "";
  pendingMatch = null;
}

function spawnConfetti() {
  const container = $("#match-confetti");
  container.innerHTML = "";
  for (let i = 0; i < 26; i++) {
    const piece = document.createElement("span");
    piece.style.left = Math.random() * 100 + "%";
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    piece.style.animationDelay = Math.random() * 0.6 + "s";
    piece.style.animationDuration = 1.8 + Math.random() * 1.2 + "s";
    container.appendChild(piece);
  }
}

$("#match-dismiss-btn").addEventListener("click", hideMatchCelebration);
$("#match-chat-btn").addEventListener("click", () => {
  if (!pendingMatch) return;
  const match = pendingMatch;
  hideMatchCelebration();
  switchTab("matches");
  openChat(match);
});

// ---------- Chat ----------

const chatHistories = new Map(); // id -> [{from, text, ts, self}]

function openChat(match) {
  state.activeChatId = match.id;
  $("#chat-avatar").textContent = match.emoji;
  $("#chat-name").textContent = match.name;
  $("#chat-messages").innerHTML = "";
  (chatHistories.get(match.id) || []).forEach(renderChatBubble);
  showScreen("chat");
  document.getElementById("screen-chat").classList.add("active");
}

$("#chat-back").addEventListener("click", () => {
  state.activeChatId = null;
  document.getElementById("screen-chat").classList.remove("active");
  showScreen("main");
});

function appendChatMessage(msg) {
  const otherId = msg.self ? state.activeChatId : msg.from;
  if (!otherId) return; // mensaje propio recibido sin chat activo (no debería pasar en uso normal)
  if (!chatHistories.has(otherId)) chatHistories.set(otherId, []);
  chatHistories.get(otherId).push(msg);
  if (state.activeChatId === otherId) {
    renderChatBubble(msg);
  }
}

function renderChatBubble(msg) {
  const el = document.createElement("div");
  el.className = "msg " + (msg.self ? "out" : "in");
  el.textContent = msg.text;
  $("#chat-messages").appendChild(el);
  $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
}

function sendChat() {
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text || !state.activeChatId) return;
  send({ type: "chat", targetId: state.activeChatId, text });
  input.value = "";
}
$("#chat-send").addEventListener("click", sendChat);
$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

// ---------- Juego: Verdad o Reto (18+) ----------
// Independiente del radar de proximidad: se juega dentro de una sala con
// código, entre personas que ya están reunidas físicamente y deciden
// voluntariamente participar.

$("#tab-game").addEventListener("click", openGame);

function openGame() {
  showScreen("game");
  document.getElementById("screen-game").classList.add("active");
  renderGame();
}

$("#game-back").addEventListener("click", () => {
  document.getElementById("screen-game").classList.remove("active");
  showScreen("main");
});

$("#consent-checkbox").addEventListener("change", (e) => {
  $("#consent-continue").disabled = !e.target.checked;
});
$("#consent-continue").addEventListener("click", () => {
  state.gameConsent = true;
  renderGame();
});

function wireIntensityPicker(containerId, onSelect) {
  const buttons = document.querySelectorAll(`#${containerId} button`);
  buttons.forEach((b) => {
    b.addEventListener("click", () => {
      buttons.forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
      onSelect(b.dataset.value);
    });
  });
}
wireIntensityPicker("intensity-picker-create", (v) => {
  state.createIntensity = v;
});
wireIntensityPicker("intensity-picker-room", (v) => {
  send({ type: "room:setIntensity", intensity: v });
});

$("#btn-create-room").addEventListener("click", () => {
  send({ type: "room:create", intensity: state.createIntensity || "suave" });
});

$("#btn-join-room").addEventListener("click", () => {
  const code = $("#join-code").value.trim().toUpperCase();
  if (!code) return;
  $("#game-home-error").style.display = "none";
  send({ type: "room:join", code });
});

$("#btn-start-game").addEventListener("click", () => send({ type: "room:start" }));
$("#btn-spin").addEventListener("click", () => send({ type: "room:spin" }));
$("#btn-choice-truth").addEventListener("click", () => send({ type: "room:choice", choice: "truth" }));
$("#btn-choice-dare").addEventListener("click", () => send({ type: "room:choice", choice: "dare" }));
$("#btn-pass").addEventListener("click", () => send({ type: "room:pass" }));
$("#btn-next-mine").addEventListener("click", () => send({ type: "room:next" }));
$("#btn-next-host").addEventListener("click", () => send({ type: "room:next" }));

$("#btn-leave-room").addEventListener("click", () => {
  send({ type: "room:leave" });
  state.room = null;
  state.lastPhase = null;
  renderGame();
});

function spinWheelAnimation() {
  const wheel = $("#wheel");
  if (!wheel) return;
  wheel.style.transition = "none";
  wheel.classList.remove("spinning");
  void wheel.offsetWidth; // fuerza reflow para poder reiniciar la animación
  wheel.style.transition = "";
  requestAnimationFrame(() => wheel.classList.add("spinning"));
}

function renderGame() {
  const consentDone = state.gameConsent;
  $("#game-consent").style.display = consentDone ? "none" : "flex";
  $("#game-home").style.display = consentDone && !state.room ? "flex" : "none";
  $("#game-room").style.display = consentDone && state.room ? "flex" : "none";

  if (!consentDone || !state.room) return;

  const room = state.room;
  $("#room-code-display").textContent = room.code;

  const playersWrap = $("#room-players");
  playersWrap.innerHTML = "";
  room.players.forEach((p) => {
    const el = document.createElement("div");
    el.className = "room-player" + (p.id === room.hostId ? " is-host" : "");
    el.innerHTML = `<span class="avatar">${p.emoji}</span> ${escapeHtml(p.name)}${
      p.id === room.hostId ? ' <span class="host-badge">HOST</span>' : ""
    }`;
    playersWrap.appendChild(el);
  });

  const isHost = room.hostId === state.id;
  const isSelected = room.selectedId === state.id;

  ["lobby", "ready", "choosing", "prompt"].forEach((phase) => {
    const el = $(`#game-phase-${phase}`);
    if (el) el.style.display = room.phase === phase ? "flex" : "none";
  });

  if (room.phase === "lobby") {
    $("#host-controls-lobby").style.display = isHost ? "block" : "none";
    $("#waiting-host-lobby").style.display = isHost ? "none" : "block";
    if (isHost) {
      $("#btn-start-game").disabled = room.players.length < 2;
      document.querySelectorAll("#intensity-picker-room button").forEach((b) => {
        b.classList.toggle("selected", b.dataset.value === room.intensity);
      });
    }
  }

  if (room.phase === "ready") {
    $("#btn-spin").style.display = isHost ? "block" : "none";
    $("#waiting-host-spin").style.display = isHost ? "none" : "block";
  }

  if (room.phase === "choosing") {
    const sel = room.players.find((p) => p.id === room.selectedId);
    $("#selected-player-choosing").innerHTML = sel
      ? `<span class="avatar">${sel.emoji}</span><span class="name">${escapeHtml(sel.name)}</span><span class="caption">¡Le toca elegir!</span>`
      : "";
    $("#my-choice-buttons").style.display = isSelected ? "flex" : "none";
    $("#waiting-choice").style.display = !isSelected ? "block" : "none";
    if (!isSelected) {
      $("#waiting-choice").textContent = sel ? `Esperando a que ${sel.name} elija Verdad o Reto…` : "";
    }
  }

  if (room.phase === "prompt") {
    const sel = room.players.find((p) => p.id === room.selectedId);
    $("#selected-player-prompt").innerHTML = sel
      ? `<span class="avatar">${sel.emoji}</span><span class="name">${escapeHtml(sel.name)}</span>`
      : "";
    $("#prompt-badge").textContent = room.choice === "dare" ? "🔥 Reto" : "💬 Verdad";
    $("#prompt-text").textContent = room.prompt || "";
    $("#prompt-buttons-mine").style.display = isSelected ? "flex" : "none";
    $("#btn-next-host").style.display = !isSelected && isHost ? "block" : "none";
    $("#waiting-prompt").style.display = !isSelected && !isHost ? "block" : "none";
    if (!isSelected && !isHost) {
      $("#waiting-prompt").textContent = sel ? `${sel.name} está respondiendo/cumpliendo…` : "";
    }
  }

  if (state.lastPhase === "ready" && room.phase === "choosing") {
    spinWheelAnimation();
  }
  state.lastPhase = room.phase;
}

// ---------- Utils ----------

function showToast(text) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Reanudar sesión guardada ----------
// Si ya habías creado un perfil en este navegador, te salta la pantalla de
// inicio y te reconecta directamente con tu perfil, tus intereses y tus
// matches ya confirmados (usando el token guardado en localStorage).
(function tryResumeSession() {
  const saved = loadProfile();
  if (!saved || !saved.name) return;

  state.selectedEmoji = saved.emoji || state.selectedEmoji;
  state.selectedInterests = new Set(saved.interests || []);
  $("#name").value = saved.name || "";
  $("#bio").value = saved.bio || "";
  $("#lookingFor").value = saved.lookingFor || "";
  renderEmojiPicker();
  renderInterestsPicker();

  startWithProfile(saved, { skipSave: true });
})();
