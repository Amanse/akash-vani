const HEARTBEAT_MS = 2000;
const STRICT = { deadband: 0.05, hardSeek: 1.0 };
const LOOSE = { deadband: 2.0, hardSeek: 6.0 }; // while someone is buffering
const LOOSE_HOLD_MS = 10000; // stay loose this long after buffering ends
const MAX_NUDGE = 0.15;
const EXPECT_TTL = 20000; // remote-applied change may take long to land on a slow source

/**
 * Mirrors play/pause/seek/rate between two players.
 * Echo avoidance: before applying a remote change we flag which player event
 * we expect to fire; the matching local event is swallowed once.
 * Host sends heartbeats; guest corrects drift against them.
 * Buffering: either side reporting a stall switches both to LOOSE tolerance
 * (allows a few seconds of gap, no hard seeks that would stall again).
 */
export class Sync {
  constructor(player, send, isHost, onDurationWarn) {
    this.p = player;
    this.send = send;
    this.isHost = isHost;
    this.onDurationWarn = onDurationWarn;
    this.enabled = true; // false while a streamed video replaces the local one
    this.expected = new Map(); // type -> timestamp
    this.baseRate = 1;
    this.remoteDuration = null;
    this.timer = null;
    this.quietUntil = 0; // ignore stale heartbeats right after any state change
    this.localBuffering = false;
    this.remoteBuffering = false;
    this.lastBufferAt = 0;

    player.on('play', () => this.local('play'));
    player.on('pause', () => this.local('pause'));
    player.on('seeked', () => this.local('seeked'));
    player.on('ratechange', () => this.local('ratechange'));
    player.on('metadata', () => { this.sendMeta(); this.checkDuration(); });
    player.on('waiting', () => this.setLocalBuffering(true));
    player.on('ready', () => this.setLocalBuffering(false));
  }

  start() {
    this.stop();
    this.sendMeta();
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    if (this.isHost) this.heartbeat();
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  get loose() {
    return this.localBuffering || this.remoteBuffering || performance.now() - this.lastBufferAt < LOOSE_HOLD_MS;
  }

  setLocalBuffering(on) {
    if (on === this.localBuffering || !this.p.hasSource()) return;
    this.localBuffering = on;
    this.lastBufferAt = performance.now();
    if (this.enabled) this.send({ t: 'buf', on });
  }

  expect(type) { this.expected.set(type, performance.now()); }
  consume(type) {
    const at = this.expected.get(type);
    if (at == null) return false;
    this.expected.delete(type);
    return performance.now() - at < EXPECT_TTL;
  }

  // ---- local -> remote
  local(type) {
    if (!this.enabled) return;
    if (this.consume(type)) return; // echo of a remote-applied change
    if (type === 'seeked' && this.p.isSeeking()) return;
    this.quietUntil = performance.now() + 1500;
    const time = this.p.getTime();
    if (type === 'play') this.send({ t: 'play', time });
    else if (type === 'pause') this.send({ t: 'pause', time });
    else if (type === 'seeked') this.send({ t: 'seek', time });
    else if (type === 'ratechange') {
      this.baseRate = this.p.getRate();
      this.send({ t: 'rate', rate: this.baseRate, time });
    }
  }

  heartbeat() {
    if (!this.isHost || !this.p.hasSource()) return;
    this.send({
      t: 'hb', time: this.p.getTime(), paused: this.p.isPaused(), rate: this.baseRate,
      duration: this.p.getDuration(),
    });
  }

  sendMeta() {
    const d = this.p.getDuration();
    if (Number.isFinite(d)) this.send({ t: 'meta', duration: d });
  }

  checkDuration() {
    const d = this.p.getDuration();
    if (this.remoteDuration == null || !Number.isFinite(d)) return this.onDurationWarn(null);
    const diff = Math.abs(d - this.remoteDuration);
    this.onDurationWarn(diff > 0.5 ? { local: d, remote: this.remoteDuration } : null);
  }

  // ---- remote -> local
  async handle(m) {
    if (m.t === 'buf') { this.remoteBuffering = m.on; this.lastBufferAt = performance.now(); return; }
    if (m.t === 'meta') { this.remoteDuration = m.duration; this.checkDuration(); return; }
    if (!this.enabled) return;
    if (m.t !== 'hb') this.quietUntil = performance.now() + 1500;
    switch (m.t) {
      case 'play': this.seekTo(m.time, 0.3); await this.setPaused(false); break;
      case 'pause': this.setPaused(true); this.seekTo(m.time, 0.05); break;
      case 'seek': this.seekTo(m.time, 0.05); break;
      case 'rate': this.baseRate = m.rate; this.setRate(m.rate); this.seekTo(m.time, 0.3); break;
      case 'hb': if (!this.isHost) await this.onHeartbeat(m); break;
    }
  }

  seekTo(t, tolerance) {
    if (!this.p.hasSource() || !Number.isFinite(t) || this.p.isSeeking()) return;
    if (Math.abs(this.p.getTime() - t) > tolerance) { this.expect('seeked'); this.p.seek(t); }
  }
  async setPaused(paused) {
    if (!this.p.hasSource() || this.p.isPaused() === paused) return;
    this.expect(paused ? 'pause' : 'play');
    try { paused ? this.p.pause() : await this.p.play(); }
    catch { this.consume(paused ? 'pause' : 'play'); /* autoplay blocked */ }
  }
  setRate(r) {
    if (Math.abs(this.p.getRate() - r) < 0.001) return;
    this.expect('ratechange');
    this.p.setRate(r);
  }

  async onHeartbeat(m) {
    if (!this.p.hasSource() || performance.now() < this.quietUntil) return;
    if (m.rate !== this.baseRate) { this.baseRate = m.rate; this.setRate(m.rate); }
    if (this.p.isPaused() !== m.paused) await this.setPaused(m.paused);
    // Never fight a stalled/seeking player: let it catch up, tolerate the gap.
    if (this.localBuffering || this.p.isSeeking() || !this.p.isReady()) return;
    const tol = this.loose ? LOOSE : STRICT;
    if (m.paused) { this.seekTo(m.time, Math.max(0.3, tol.deadband)); return; }
    const drift = this.p.getTime() - m.time; // + = we are ahead
    if (Math.abs(drift) > tol.hardSeek) {
      this.seekTo(m.time, 0);
      this.setRate(this.baseRate);
    } else if (Math.abs(drift) > tol.deadband) {
      const k = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, drift * 0.5));
      this.setRate(this.baseRate * (1 - k));
    } else {
      this.setRate(this.baseRate);
    }
  }
}
