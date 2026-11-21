// Transport: how frames reach the server. LAN uses WebSocket (TCP: on a LAN
// head-of-line blocking is a non-issue and it needs no signalling). The
// session only uses this interface, so a cloud build can drop in an
// unreliable transport (WebTransport datagrams / WebRTC data channel) for the
// hot binary frames without touching the game code:
//   open, send(string | ArrayBuffer), close(), bufferedAmount,
//   handlers: onopen(), ontext(string), onbinary(ArrayBuffer), onclose(reason)
export class WebSocketTransport {
  constructor(url) {
    this.url = url;
    this.onopen = this.ontext = this.onbinary = this.onclose = null;
    const ws = this.ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this.onopen?.();
    ws.onmessage = (m) => (typeof m.data === 'string' ? this.ontext?.(m.data) : this.onbinary?.(m.data));
    ws.onclose = (e) => this.onclose?.(e.reason || `closed (${e.code})`);
    ws.onerror = () => {};
  }
  get open() { return this.ws.readyState === 1; }
  get bufferedAmount() { return this.ws.bufferedAmount; }
  send(data) { if (this.ws.readyState === 1) this.ws.send(data); }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}
