/** Voice-only call over PeerJS media. */
export class Voice {
  constructor(audioEl, ui) {
    this.audio = audioEl;
    this.ui = ui; // {state('idle'|'incoming'|'active'), muted(bool)}
    this.stream = null;
    this.call = null;
    this.pending = null;
  }

  async mic() {
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  }

  async start(peer, remoteId) {
    this.stream = await this.mic();
    this.attach(peer.call(remoteId, this.stream));
  }

  incoming(call) {
    if (this.call) { call.close(); return; }
    this.pending = call;
    call.on('close', () => { if (this.pending === call) { this.pending = null; this.ui.state('idle'); } });
    this.ui.state('incoming');
  }

  async answer() {
    const call = this.pending;
    if (!call) return;
    this.pending = null;
    this.stream = await this.mic();
    call.answer(this.stream);
    this.attach(call);
  }

  attach(call) {
    this.call = call;
    call.on('stream', (s) => { this.audio.srcObject = s; this.audio.play().catch(() => {}); });
    call.on('close', () => this.hangUp());
    call.on('error', () => this.hangUp());
    this.ui.state('active');
    this.setMuted(false);
  }

  setMuted(m) {
    this.muted = m;
    if (this.stream) this.stream.getAudioTracks().forEach((t) => (t.enabled = !m));
    this.ui.muted(m);
  }
  toggleMute() { this.setMuted(!this.muted); }

  hangUp() {
    if (this.call) { const c = this.call; this.call = null; c.close(); }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this.audio.srcObject = null;
    this.ui.state('idle');
  }
}
