import { HtmlVideoPlayer } from './player.js';
import { Sync } from './sync.js';
import { Net, normalizeRoom } from './net.js';
import { Voice } from './voice.js';

const $ = (id) => document.getElementById(id);
const player = new HtmlVideoPlayer($('video'));
let net = null;
let sync = null;
let objectUrl = null;

// ---------- status / UI helpers
function setStatus(state, text) {
  $('status').dataset.state = state;
  $('statusText').textContent = text;
}
function logMsg(text, cls = '') {
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.textContent = text;
  $('log').appendChild(d);
  $('log').scrollTop = $('log').scrollHeight;
}
function fmt(s) {
  s = Math.round(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function durationWarn(info) {
  const w = $('warn');
  w.hidden = !info;
  if (info) w.textContent = `Warning: video lengths differ (you ${fmt(info.local)}, them ${fmt(info.remote)}). Playback may not line up.`;
}
function setChatEnabled(on) {
  $('chatInput').disabled = !on;
  $('sendBtn').disabled = !on;
}

// ---------- voice
const voice = new Voice($('remoteAudio'), {
  state(s) {
    $('callBtn').hidden = s !== 'idle';
    $('muteBtn').hidden = s !== 'active';
    $('hangBtn').hidden = s !== 'active';
    $('incoming').hidden = s !== 'incoming';
  },
  muted(m) { $('muteBtn').textContent = m ? 'Unmute' : 'Mute'; },
});
$('callBtn').onclick = async () => {
  if (!net || !net.remoteId) return logMsg('Not connected yet', 'sys');
  try { await voice.start(net.peer, net.remoteId); } catch (e) { logMsg('Mic error: ' + e.message, 'sys'); }
};
$('answerBtn').onclick = async () => {
  try { await voice.answer(); } catch (e) { logMsg('Mic error: ' + e.message, 'sys'); }
};
$('muteBtn').onclick = () => voice.toggleMute();
$('hangBtn').onclick = () => voice.hangUp();

// ---------- video streaming (host -> guest over WebRTC)
const rv = $('remoteVideo');
let streamCall = null;
let streamMode = false; // guest: showing host's stream instead of local video
let hb = null; // last host heartbeat {time,paused,rate,duration,at}

function updateStreamBtn() {
  const connected = !!(net && net.remoteId);
  $('streamBtn').disabled = !(connected && net.isHost);
  $('streamBtn').textContent = streamCall ? 'Stop streaming' : 'Stream my video to peer';
  $('streamNote').textContent = connected && !net.isHost
    ? 'Only the host can stream. Ask them to press the button if your download is slow.'
    : 'Host only. Sends your playing video over WebRTC; peer needs no copy. Use if their download is slow.';
}

$('streamBtn').onclick = () => {
  if (streamCall) return stopStream();
  const el = $('video');
  if (!player.hasSource()) return logMsg('Load a video first', 'sys');
  if (!player.corsOk) return logMsg('This URL blocks CORS, so it cannot be streamed. Use a local file or "Download fully first".', 'sys');
  const stream = el.captureStream ? el.captureStream() : null;
  if (!stream || !stream.getTracks().length) return logMsg('Cannot capture video yet. Press play once, then retry.', 'sys');
  streamCall = net.peer.call(net.remoteId, stream, { metadata: { kind: 'video' } });
  streamCall.on('close', () => { streamCall = null; updateStreamBtn(); });
  setTimeout(() => { // raise sender bitrate cap
    try {
      streamCall.peerConnection.getSenders().forEach((snd) => {
        if (snd.track?.kind !== 'video') return;
        const prm = snd.getParameters();
        prm.encodings = prm.encodings?.length ? prm.encodings : [{}];
        prm.encodings[0].maxBitrate = 4_000_000;
        snd.setParameters(prm);
      });
    } catch {}
  }, 1500);
  logMsg('Streaming your video to peer', 'sys');
  updateStreamBtn();
};

function stopStream() {
  if (streamCall) { const c = streamCall; streamCall = null; c.close(); }
  updateStreamBtn();
}

function receiveStream(call) {
  call.answer();
  call.on('stream', (st) => {
    streamMode = true;
    if (sync) sync.enabled = false;
    $('video').pause();
    $('video').hidden = true;
    rv.hidden = false;
    rv.srcObject = st;
    rv.play().catch(() => {});
    $('empty').classList.add('hide');
    $('streamBar').hidden = false;
    logMsg('Host is streaming the video to you', 'sys');
  });
  call.on('close', endStreamMode);
}

function endStreamMode() {
  if (!streamMode) return;
  streamMode = false;
  rv.srcObject = null;
  rv.hidden = true;
  $('video').hidden = false;
  $('streamBar').hidden = true;
  if (sync) sync.enabled = true;
  hb = null;
  logMsg('Stream ended', 'sys');
}

// guest controls while streamed: send as normal sync messages to host
$('sbPlay').onclick = () => {
  if (!hb) return;
  net.send({ t: hb.paused ? 'play' : 'pause', time: estTime() });
  hb = { ...hb, paused: !hb.paused, time: estTime(), at: performance.now() };
};
$('sbSeek').onchange = (e) => {
  const time = +e.target.value;
  net.send({ t: 'seek', time });
  if (hb) hb = { ...hb, time, at: performance.now() };
};
function estTime() {
  if (!hb) return 0;
  return hb.time + (hb.paused ? 0 : ((performance.now() - hb.at) / 1000) * hb.rate);
}
setInterval(() => {
  if (!streamMode || !hb) return;
  const t = estTime();
  $('sbPlay').textContent = hb.paused ? 'Play' : 'Pause';
  if (Number.isFinite(hb.duration)) $('sbSeek').max = hb.duration;
  if (document.activeElement !== $('sbSeek')) $('sbSeek').value = t;
  $('sbTime').textContent = `${fmt(t)} / ${fmt(hb.duration || 0)}`;
}, 250);

// ---------- room
function enterRoom(room) {
  history.replaceState(null, '', '#' + room);
  $('join').hidden = true;
  $('room').hidden = false;
  $('inviteInput').value = location.href;

  net = new Net(room, {
    status: setStatus,
    open(isHost) {
      sync = new Sync(player, (m) => net.send(m), isHost, durationWarn);
      sync.start();
      setChatEnabled(true);
      updateStreamBtn();
      logMsg('Peer connected', 'sys');
    },
    close() {
      sync?.stop();
      sync = null;
      setChatEnabled(false);
      durationWarn(null);
      voice.hangUp();
      stopStream();
      endStreamMode();
      updateStreamBtn();
      logMsg('Peer disconnected', 'sys');
    },
    message(m) {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'chat') logMsg(String(m.text).slice(0, 2000));
      else {
        if (m.t === 'hb' && streamMode) hb = { ...m, at: performance.now() };
        sync?.handle(m);
      }
    },
    call: (call) => (call.metadata?.kind === 'video' ? receiveStream(call) : voice.incoming(call)),
  });
  net.start();
}

$('joinForm').onsubmit = (e) => {
  e.preventDefault();
  const room = normalizeRoom($('roomInput').value);
  if (room) enterRoom(room);
};

// ---------- source
document.querySelectorAll('input[name=srcType]').forEach((r) => {
  r.onchange = () => {
    const file = r.value === 'file' && r.checked;
    $('fileInput').hidden = !file;
    $('urlInput').hidden = file;
  };
});
async function prefetch(url) {
  const info = $('prefetchInfo');
  info.hidden = false;
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = +res.headers.get('content-length') || 0;
    const chunks = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      info.textContent = `Downloading… ${(got / 1e6).toFixed(1)} MB` + (total ? ` (${Math.round((got / total) * 100)}%)` : '');
    }
    info.textContent = `Downloaded ${(got / 1e6).toFixed(1)} MB. Playing from memory.`;
    return URL.createObjectURL(new Blob(chunks, { type: res.headers.get('content-type') || 'video/mp4' }));
  } catch (err) {
    info.textContent = `Full download failed (${err.message}); streaming normally.`;
    return null;
  }
}

$('srcForm').onsubmit = async (e) => {
  e.preventDefault();
  const type = document.querySelector('input[name=srcType]:checked').value;
  let src;
  if (type === 'file') {
    const f = $('fileInput').files[0];
    if (!f) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    src = objectUrl = URL.createObjectURL(f);
  } else {
    src = $('urlInput').value.trim();
    if (!src) return;
    if ($('prefetch').checked) {
      const blobUrl = await prefetch(src);
      if (blobUrl) { if (objectUrl) URL.revokeObjectURL(objectUrl); src = objectUrl = blobUrl; }
    } else $('prefetchInfo').hidden = true;
  }
  player.load(src);
  $('empty').classList.add('hide');
};

// ---------- chat / invite
$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  net.send({ t: 'chat', text });
  logMsg(text, 'me');
  $('chatInput').value = '';
};
$('copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText($('inviteInput').value); }
  catch { $('inviteInput').select(); document.execCommand('copy'); }
  $('copyBtn').textContent = 'Copied';
  setTimeout(() => ($('copyBtn').textContent = 'Copy'), 1500);
};

// ---------- boot: room from hash
const hashRoom = normalizeRoom(decodeURIComponent(location.hash.slice(1)));
if (hashRoom) $('roomInput').value = hashRoom;
