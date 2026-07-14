// lib/mini-ws.js
//
// Implementacion minima de un servidor WebSocket (RFC 6455) usando solo
// modulos nativos de Node (http/crypto/events). Se escribio a mano porque
// este entorno no tiene acceso al registro de npm; para un proyecto real
// se recomienda usar el paquete "ws" en su lugar (mismo API basico:
// on("connection"), ws.on("message"), ws.send(), ws.readyState).

const crypto = require("crypto");
const { EventEmitter } = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPEN = 1;
const CLOSED = 3;

class MiniWebSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = OPEN;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentedOpcode = null;

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._onClose());
    socket.on("error", (err) => this.emit("error", err));
  }

  _onData(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    while (true) {
      const parsed = this._tryParseFrame(this._buffer);
      if (!parsed) break;
      this._buffer = this._buffer.subarray(parsed.frameLength);
      this._handleFrame(parsed);
    }
  }

  _tryParseFrame(buf) {
    if (buf.length < 2) return null;
    const byte0 = buf[0];
    const fin = (byte0 & 0x80) !== 0;
    const opcode = byte0 & 0x0f;
    const byte1 = buf[1];
    const masked = (byte1 & 0x80) !== 0;
    let payloadLen = byte1 & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buf.length < offset + 2) return null;
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (buf.length < offset + 8) return null;
      const high = buf.readUInt32BE(offset);
      const low = buf.readUInt32BE(offset + 4);
      payloadLen = high * 2 ** 32 + low;
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + payloadLen) return null;

    let payload = buf.subarray(offset, offset + payloadLen);
    if (masked) {
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }

    return { fin, opcode, payload, frameLength: offset + payloadLen };
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;

    if (opcode === 0x8) {
      this._sendFrame(0x8, Buffer.alloc(0));
      this.socket.end();
      this._onClose();
      return;
    }
    if (opcode === 0x9) {
      this._sendFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) return;

    if (opcode === 0x1 || opcode === 0x2) {
      this._fragmentedOpcode = opcode;
      this._fragments = [payload];
    } else if (opcode === 0x0) {
      this._fragments.push(payload);
    } else {
      return;
    }

    if (fin) {
      const full = Buffer.concat(this._fragments);
      this._fragments = [];
      const wasText = this._fragmentedOpcode === 0x1;
      this._fragmentedOpcode = null;
      if (wasText) this.emit("message", full.toString("utf8"));
    }
  }

  _onClose() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit("close");
  }

  _sendFrame(opcode, payload) {
    if (this.socket.destroyed || this.readyState !== OPEN) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
      header.writeUInt32BE(len % 2 ** 32, 6);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(data) {
    if (this.readyState !== OPEN) return;
    this._sendFrame(0x1, Buffer.from(data, "utf8"));
  }

  close() {
    this._sendFrame(0x8, Buffer.alloc(0));
    this.socket.end();
    this._onClose();
  }
}
MiniWebSocket.prototype.OPEN = OPEN;
MiniWebSocket.prototype.CLOSED = CLOSED;

class MiniWebSocketServer extends EventEmitter {
  constructor(httpServer) {
    super();
    httpServer.on("upgrade", (req, socket, head) => {
      if ((req.headers["upgrade"] || "").toLowerCase() !== "websocket") {
        socket.destroy();
        return;
      }
      const key = req.headers["sec-websocket-key"];
      if (!key) {
        socket.destroy();
        return;
      }
      const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          "",
        ].join("\r\n")
      );

      const ws = new MiniWebSocket(socket);
      if (head && head.length) ws._onData(head);
      this.emit("connection", ws, req);
    });
  }
}

module.exports = { WebSocketServer: MiniWebSocketServer, OPEN, CLOSED };
