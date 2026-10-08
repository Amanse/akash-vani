/**
 * Player interface. Any implementation (e.g. a future YouTubePlayer) must provide:
 *   load(src)            -> start loading a source
 *   play() / pause()     -> Promise|void
 *   seek(seconds)
 *   setRate(rate)
 *   getTime() / getRate() / getDuration() / isPaused()
 *   on(event, cb)        -> events: 'play' 'pause' 'seeked' 'ratechange' 'metadata'
 * Events fire for user AND programmatic changes; Sync filters its own echoes.
 */
export class HtmlVideoPlayer {
  constructor(el) {
    this.el = el;
    this.handlers = {};
    const map = { play: 'play', pause: 'pause', seeked: 'seeked', ratechange: 'ratechange', loadedmetadata: 'metadata' };
    for (const [domEvt, evt] of Object.entries(map)) {
      el.addEventListener(domEvt, () => this.emit(evt));
    }
  }
  on(evt, cb) { (this.handlers[evt] ||= []).push(cb); }
  emit(evt, ...a) { (this.handlers[evt] || []).forEach((cb) => cb(...a)); }
  load(src) { this.el.src = src; this.el.load(); }
  play() { return this.el.play(); }
  pause() { this.el.pause(); }
  seek(t) { this.el.currentTime = t; }
  setRate(r) { this.el.playbackRate = r; }
  getTime() { return this.el.currentTime; }
  getRate() { return this.el.playbackRate; }
  getDuration() { return this.el.duration; }
  isPaused() { return this.el.paused; }
  hasSource() { return !!this.el.currentSrc; }
}
