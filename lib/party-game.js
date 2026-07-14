// lib/party-game.js
//
// Juego de fiesta "Verdad o Reto" (solo para mayores de 18 años).
//
// IMPORTANTE — este modulo es intencionalmente independiente del radar de
// proximidad/citas de la app: no usa ubicacion, no usa matches, y solo se
// juega dentro de una "sala" con codigo, pensada para un grupo de personas
// que YA estan reunidas fisicamente y deciden voluntariamente jugar juntas
// (por ejemplo, en una fiesta). Nadie puede ser arrastrado a una sala sin
// el codigo, y cualquier reto se puede pasar en cualquier momento.
//
// El contenido "picante" es coqueto/romantico para adultos (besos en la
// mejilla, piropos, abrazos, quitarse un accesorio) pero deliberadamente
// NO incluye instrucciones de actos sexuales explicitos ni desnudos.

const CONTENT = {
  suave: {
    truth: [
      "¿Cuál ha sido la cita más rara que has tenido?",
      "¿Qué canción no puede faltar en una noche de fiesta contigo?",
      "¿Cuál es la mentirijilla que más repites?",
      "Si tuvieras que ponerle apodo a alguien del grupo, ¿cuál sería y por qué?",
      "¿Cuál es tu red social con el contenido más vergonzoso?",
      "Cuenta la anécdota más incómoda que te ha pasado en una fiesta.",
      "¿A quién del grupo llamarías primero en una emergencia?",
      "¿Cuál ha sido tu peor primera impresión de alguien que luego resultó buena persona?",
      "¿Qué es lo más espontáneo que has hecho este año?",
      "Si pudieras cambiar de vida con alguien del grupo por un día, ¿con quién y por qué?",
      "¿Cuál es tu comida vergonzosamente favorita?",
      "¿Qué serie o película has visto demasiadas veces?",
    ],
    dare: [
      "Imita el acento de otra región durante las próximas 3 rondas.",
      "Baila como si nadie te viera durante 15 segundos.",
      "Deja que el grupo te despeine o te haga un peinado ridículo (nada permanente).",
      "Habla con acento robótico hasta tu próximo turno.",
      "Haz una imitación de alguien famoso y que el grupo adivine quién es.",
      "Cuenta un chiste malo y aguanta la risa.",
      "Camina como un pato hasta el otro lado de la sala y vuelve.",
      "Canta el estribillo de tu canción favorita a capela.",
      "Cambia de asiento con la persona más alejada de ti.",
      "Deja que alguien del grupo elija tu foto de perfil por 10 minutos.",
      "Haz de presentador de telediario contando algo random que haya pasado hoy.",
      "Enseña tu última foto random de la galería (que no sea privada).",
    ],
  },
  picante: {
    truth: [
      "¿Cuál ha sido el beso más memorable de tu vida y por qué?",
      "Del grupo, ¿a quién le darías una cita a ciegas?",
      "¿Qué es lo primero que se te queda de alguien que te atrae?",
      "¿Cuál es tu mayor fantasía romántica (sin entrar en detalles explícitos)?",
      "¿Alguna vez te ha gustado alguien de este grupo? No hace falta decir quién si no quieres.",
      "Describe tu cita ideal de principio a fin.",
      "¿Cuál es el piropo que más te ha funcionado (o el peor que te han dicho)?",
      "¿Prefieres un mensaje a medianoche o una llamada sorpresa?",
      "¿Qué gesto pequeño te conquista más rápido: un detalle, una broma o un cumplido?",
      "Si tuvieras que elegir a alguien del grupo para un baile lento, ¿quién sería?",
      "¿Cuál es tu mayor turn-off en una primera cita?",
      "¿Qué canción pondrías para ambientar una cita romántica?",
    ],
    dare: [
      "Dale un beso en la mejilla a la persona que elijas del grupo.",
      "Susúrrale un piropo al oído a alguien del grupo.",
      "Quítate un accesorio (reloj, gafas, pañuelo, cinturón...) y no te lo pongas hasta que acabe el juego.",
      "Dale un abrazo de 10 segundos a la persona a tu derecha.",
      "Cógele la mano a alguien del grupo durante la siguiente ronda.",
      "Hazle un cumplido sincero y específico a la persona que tienes enfrente.",
      "Deja que alguien del grupo te elija un apodo cariñoso para el resto de la noche.",
      "Baila lento 20 segundos con la persona que tú elijas.",
      "Mírale fijamente a los ojos a alguien del grupo durante 20 segundos sin reírte.",
      "Dedica tu canción favorita a alguien del grupo, en voz alta.",
      "Dale un beso en la mano a la persona que elijas.",
      "Confiésale al grupo qué persona presente te pareció más atractiva al conoceros.",
    ],
  },
};

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin caracteres ambiguos (0/O, 1/I)
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createGameModule({ clients, send }) {
  /** @type {Map<string, any>} */
  const rooms = new Map();

  function roomPlayers(room) {
    return [...room.playerIds]
      .map((id) => clients.get(id))
      .filter(Boolean)
      .map((c) => ({ id: c.id, name: c.profile?.name || "Jugador", emoji: c.profile?.emoji || "🙂" }));
  }

  function publicState(room) {
    return {
      type: "room:state",
      code: room.code,
      hostId: room.hostId,
      intensity: room.intensity,
      phase: room.phase, // lobby | ready | choosing | prompt
      players: roomPlayers(room),
      selectedId: room.selectedId,
      choice: room.choice,
      prompt: room.prompt,
    };
  }

  function broadcastRoom(room) {
    const state = publicState(room);
    for (const id of room.playerIds) {
      const c = clients.get(id);
      if (c) send(c.ws, state);
    }
  }

  function sendError(client, message) {
    send(client.ws, { type: "room:error", message });
  }

  function pickPrompt(room, kind) {
    const bank = CONTENT[room.intensity][kind];
    const usedKey = `${room.intensity}:${kind}`;
    room.usedPrompts = room.usedPrompts || {};
    const used = room.usedPrompts[usedKey] || (room.usedPrompts[usedKey] = new Set());
    let available = bank.filter((_, i) => !used.has(i));
    if (available.length === 0) {
      used.clear();
      available = bank;
    }
    const text = available[Math.floor(Math.random() * available.length)];
    used.add(bank.indexOf(text));
    return text;
  }

  function leaveRoom(client) {
    const code = client.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    client.roomCode = null;
    if (!room) return;
    room.playerIds.delete(client.id);
    if (room.playerIds.size === 0) {
      rooms.delete(code);
      return;
    }
    if (room.hostId === client.id) room.hostId = [...room.playerIds][0];
    if (room.selectedId === client.id) {
      room.phase = "ready";
      room.selectedId = null;
      room.choice = null;
      room.prompt = null;
    }
    broadcastRoom(room);
  }

  function handle(client, msg) {
    switch (msg.type) {
      case "room:create": {
        if (!client.profile) return sendError(client, "Completa tu perfil antes de crear una sala.");
        if (client.roomCode) leaveRoom(client);
        let code;
        do {
          code = randomCode();
        } while (rooms.has(code));
        const intensity = msg.intensity === "picante" ? "picante" : "suave";
        const room = {
          code,
          hostId: client.id,
          intensity,
          phase: "lobby",
          playerIds: new Set([client.id]),
          selectedId: null,
          choice: null,
          prompt: null,
          usedPrompts: {},
        };
        rooms.set(code, room);
        client.roomCode = code;
        broadcastRoom(room);
        break;
      }
      case "room:join": {
        const code = String(msg.code || "").toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) return sendError(client, "No existe ninguna sala con ese código.");
        if (!client.profile) return sendError(client, "Completa tu perfil antes de unirte.");
        if (client.roomCode && client.roomCode !== code) leaveRoom(client);
        room.playerIds.add(client.id);
        client.roomCode = code;
        broadcastRoom(room);
        break;
      }
      case "room:leave": {
        leaveRoom(client);
        break;
      }
      case "room:setIntensity": {
        const room = rooms.get(client.roomCode);
        if (!room || room.hostId !== client.id || room.phase !== "lobby") return;
        room.intensity = msg.intensity === "picante" ? "picante" : "suave";
        broadcastRoom(room);
        break;
      }
      case "room:start": {
        const room = rooms.get(client.roomCode);
        if (!room || room.hostId !== client.id) return;
        if (room.playerIds.size < 2) return sendError(client, "Necesitáis al menos 2 personas para jugar.");
        room.phase = "ready";
        broadcastRoom(room);
        break;
      }
      case "room:spin": {
        const room = rooms.get(client.roomCode);
        if (!room || room.hostId !== client.id || room.phase !== "ready") return;
        const ids = [...room.playerIds];
        room.selectedId = ids[Math.floor(Math.random() * ids.length)];
        room.phase = "choosing";
        room.choice = null;
        room.prompt = null;
        broadcastRoom(room);
        break;
      }
      case "room:choice": {
        const room = rooms.get(client.roomCode);
        if (!room || room.phase !== "choosing" || room.selectedId !== client.id) return;
        const kind = msg.choice === "dare" ? "dare" : "truth";
        room.choice = kind;
        room.prompt = pickPrompt(room, kind);
        room.phase = "prompt";
        broadcastRoom(room);
        break;
      }
      case "room:pass": {
        const room = rooms.get(client.roomCode);
        if (!room || room.phase !== "prompt" || room.selectedId !== client.id) return;
        room.prompt = pickPrompt(room, room.choice);
        broadcastRoom(room);
        break;
      }
      case "room:next": {
        const room = rooms.get(client.roomCode);
        if (!room) return;
        if (room.hostId !== client.id && room.selectedId !== client.id) return;
        room.phase = "ready";
        room.selectedId = null;
        room.choice = null;
        room.prompt = null;
        broadcastRoom(room);
        break;
      }
      default:
        sendError(client, "Tipo de mensaje de juego desconocido");
    }
  }

  return { handle, leaveRoom };
}

module.exports = { createGameModule, CONTENT };
