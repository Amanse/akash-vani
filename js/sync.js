const HEARTBEAT_MS = 2000;
const HARD_SEEK = 1.0;
const DEADBAND = 0.05;
const MAX_NUDGE = 0.15;
const EXPECT_TTL = 3000;

/**
 * Mirrors play/pause/seek/rate between two players.
 * Echo avoidance: before applying a remote change we record which player event
 * we expect to fire; the matching local event is swallowed once.
 * Host sends heartbeats; guest corrects drift against them.
 */
export class Sync {
  constructor(player, send, isHost, onDurationWarn) {
    this.p = player;
    this.send = send;
    this.isHost = isHost;
    this.onDurationWarn = onDurationWarn;
    this.expected = new Map();
    this.baseRate = 1;
    this.remoteDuration = null;
    this.timer = null;
    this.quietUntil = 0; // ignore stale heartbeats right after any state change

    player.on('play', () => this.local('play'));
    player.on('pause', () => this.local('pause'));
    player.on('seeked', () => this.local('seeked'));
    player.on('ratechange', () => this.local('ratechange'));
    player.on('metadata', () => { this.sendMeta(); this.checkDuration(); });
  }

  start() {
    this.stop();
    this.sendMeta();
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    if (this.isHost) this.heartbeat();
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  expect(type) {
    this.expected.set(type, (this.expected.get(type) || 0) + 1);
    setTimeout(() => this.consume(type), EXPECT_TTL);
  }
  consume(type) {
    const n = this.expected.get(type) || 0;
    if (n > 0) { this.expected.set(type, n - 1); return true; }
    return false;
  }

  // ---- local -> remote
  local(type) {
    if (this.consume(type)) return; // echo of a remote-applied change
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
    this.send({ t: 'hb', time: this.p.getTime(), paused: this.p.isPaused(), rate: this.baseRate });
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
    if (m.t !== 'hb' && m.t !== 'meta') this.quietUntil = performance.now() + 1500;
    switch (m.t) {
      case 'meta': this.remoteDuration = m.duration; this.checkDuration(); break;
      case 'play': this.seekTo(m.time, 0.3); await this.setPaused(false); break;
      case 'pause': this.setPaused(true); this.seekTo(m.time, 0.05); break;
      case 'seek': this.seekTo(m.time, 0.05); break;
      case 'rate': this.baseRate = m.rate; this.setRate(m.rate); this.seekTo(m.time, 0.3); break;
      case 'hb': if (!this.isHost) await this.onHeartbeat(m); break;
    }
  }

  seekTo(t, tolerance) {
    if (!this.p.hasSource() || !Number.isFinite(t)) return;
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
    if (m.paused) { this.seekTo(m.time, 0.3); return; }
    const drift = this.p.getTime() - m.time; // + = we are ahead
    if (Math.abs(drift) > HARD_SEEK) {
      this.seekTo(m.time, 0);
      this.setRate(this.baseRate);
    } else if (Math.abs(drift) > DEADBAND) {
      const k = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, drift * 0.5));
      this.setRate(this.baseRate * (1 - k));
    } else {
      this.setRate(this.baseRate);
    }
  }
}
