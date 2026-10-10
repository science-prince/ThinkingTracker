// Observes complete text messages without modifying any bytes in the tunnel.
export class WebSocketInspector {
  constructor(message, warning, limit = 4194304) {
    this.message = message; this.warning = warning; this.limit = limit;
    this.buffer = Buffer.alloc(0); this.fragments = []; this.fragmentBytes = 0;
    this.opcode = null; this.compressed = false; this.disabled = false;
  }
  feed(chunk) {
    if (this.disabled) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const a = this.buffer[0], b = this.buffer[1];
      let len = b & 127, offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2); offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.limit)) { this.disable('websocket_truncated'); return; }
        len = Number(big); offset = 10;
      }
      if (len > this.limit) { this.disable('websocket_truncated'); return; }
      const masked = Boolean(b & 128), maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + len) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= this.buffer[maskOffset + (i & 3)];
      this.buffer = this.buffer.subarray(offset + len);
      const op = a & 15, fin = Boolean(a & 128);
      if (op >= 8) continue; // ping, pong, close never enter message association.
      if (op === 1 || op === 2) {
        if (this.opcode !== null) { this.disable('websocket_parse_error'); return; }
        this.opcode = op; this.compressed = Boolean(a & 64);
      } else if (op !== 0 || this.opcode === null) { this.disable('websocket_parse_error'); return; }
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.limit) { this.disable('websocket_truncated'); return; }
      this.fragments.push(payload);
      if (fin) {
        if (this.compressed) this.warning('compressed_websocket_unsupported');
        else if (this.opcode === 1) {
          try { this.message(JSON.parse(Buffer.concat(this.fragments).toString('utf8'))); }
          catch { this.warning('websocket_parse_error'); }
        } else this.warning('binary_websocket_unsupported');
        this.fragments = []; this.fragmentBytes = 0; this.opcode = null; this.compressed = false;
      }
    }
  }
  disable(code) {
    this.disabled = true; this.buffer = Buffer.alloc(0); this.fragments = [];
    this.warning(code);
  }
}
