const PREFIX = 'akash-vani-room-';

export function normalizeRoom(s) {
  return s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/**
 * First joiner claims peer id PREFIX+room (host). If taken, join as guest and
 * connect to it. If host vanishes, guest restarts and may become host.
 */
export class Net {
  constructor(room, cb) {
    this.room = room;
    this.hostId = PREFIX + room;
    this.cb = cb; // {status(state,text), open(isHost), close(), message(m), call(call)}
    this.peer = null;
    this.conn = null;
    this.isHost = false;
    this.stopped = false;
    this.retry = null;
  }

  start() {
    this.cleanup();
    this.cb.status('connecting', 'Connecting to signaling server…');
    const peer = new Peer(this.hostId);
    this.peer = peer;
    peer.on('open', () => {
      this.isHost = true;
      this.cb.status('waiting', 'Waiting for the other person…');
      this.hookPeer(peer);
      peer.on('connection', (c) => this.setConn(c));
    });
    peer.on('error', (e) => {
      if (peer !== this.peer) return;
      if (e.type === 'unavailable-id') { peer.destroy(); this.startGuest(); }
      else this.onError(e);
    });
  }

  startGuest() {
    this.cleanup();
    const peer = new Peer();
    this.peer = peer;
    this.isHost = false;
    peer.on('open', () => {
      this.hookPeer(peer);
      this.cb.status('connecting', 'Connecting to peer…');
      this.setConn(peer.connect(this.hostId, { reliable: true }));
    });
    peer.on('error', (e) => {
      if (peer !== this.peer) return;
      if (e.type === 'peer-unavailable') this.restartSoon(); // host gone; maybe become host
      else this.onError(e);
    });
  }

  hookPeer(peer) {
    peer.on('call', (call) => this.cb.call(call));
    peer.on('disconnected', () => { if (!this.stopped && peer === this.peer && !peer.destroyed) peer.reconnect(); });
  }

  setConn(conn) {
    if (this.isHost && this.conn && this.conn.open) { conn.close(); return; } // room full
    this.conn = conn;
    conn.on('open', () => {
      this.cb.status('connected', 'Connected');
      this.cb.open(this.isHost);
    });
    conn.on('data', (m) => this.cb.message(m));
    conn.on('close', () => {
      if (conn !== this.conn) return;
      this.conn = null;
      this.cb.close();
      if (this.isHost) this.cb.status('waiting', 'Peer left. Waiting…');
      else this.restartSoon();
    });
  }

  onError(e) {
    this.cb.status('error', `Error: ${e.type || e.message}`);
    this.restartSoon(4000);
  }

  restartSoon(ms = 1500) {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.cb.status('connecting', 'Reconnecting…');
    this.retry = setTimeout(() => this.start(), ms);
  }

  send(m) { if (this.conn && this.conn.open) this.conn.send(m); }
  get remoteId() { return this.conn && this.conn.peer; }

  cleanup() {
    if (this.conn) { const c = this.conn; this.conn = null; c.close(); }
    if (this.peer) { const p = this.peer; this.peer = null; p.destroy(); }
  }
  stop() { this.stopped = true; clearTimeout(this.retry); this.cleanup(); }
}
