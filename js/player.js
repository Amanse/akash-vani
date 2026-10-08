/**
 * Player interface. Any implementation (e.g. a future YouTubePlayer) must provide:
 *   load(src)            -> start loading a source
 *   play() / pause()     -> Promise|void
 *   seek(seconds)
 *   setRate(rate)
 *   getTime() / getRate() / getDuration() / isPaused()
 *   isSeeking() / isReady() / hasSource() / corsOk
 *   on(event, cb)        -> events: 'play' 'pause' 'seeked' 'ratechange' 'metadata'
 *                           'waiting' (buffering) 'ready' (can play) 'error'
 * Events fire for user AND programmatic changes; Sync filters its own echoes.
 */
export class HtmlVideoPlayer {
  constructor(el) {
    this.el = el;
    this.handlers = {};
    el.preload = 'auto';
    this.corsOk = true;
    const map = {
      play: 'play', pause: 'pause', seeked: 'seeked', ratechange: 'ratechange', loadedmetadata: 'metadata',
      waiting: 'waiting', stalled: 'waiting', playing: 'ready', canplay: 'ready',
    };
    for (const [domEvt, evt] of Object.entries(map)) {
      el.addEventListener(domEvt, () => this.emit(evt));
    }
  }
  on(evt, cb) { (this.handlers[evt] ||= []).push(cb); }
  emit(evt, ...a) { (this.handlers[evt] || []).forEach((cb) => cb(...a)); }
  /** Try CORS-clean first (needed for captureStream); fall back to plain load. */
  load(src) {
    const el = this.el;
    const blob = src.startsWith('blob:');
    this.corsOk = true;
    if (blob) el.removeAttribute('crossorigin'); else el.crossOrigin = 'anonymous';
    el.onerror = () => {
      if (el.crossOrigin) {
        el.removeAttribute('crossorigin');
        this.corsOk = false;
        el.src = src; el.load();
      } else this.emit('error');
    };
    el.src = src; el.load();
  }
  play() { return this.el.play(); }
  pause() { this.el.pause(); }
  seek(t) { this.el.currentTime = t; }
  setRate(r) { this.el.playbackRate = r; }
  getTime() { return this.el.currentTime; }
  getRate() { return this.el.playbackRate; }
  getDuration() { return this.el.duration; }
  isPaused() { return this.el.paused; }
  isSeeking() { return this.el.seeking; }
  isReady() { return this.el.readyState >= 3; }
  hasSource() { return !!this.el.currentSrc; }
}
