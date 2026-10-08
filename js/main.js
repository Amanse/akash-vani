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
      logMsg('Peer connected', 'sys');
    },
    close() {
      sync?.stop();
      sync = null;
      setChatEnabled(false);
      durationWarn(null);
      voice.hangUp();
      logMsg('Peer disconnected', 'sys');
    },
    message(m) {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'chat') logMsg(String(m.text).slice(0, 2000));
      else sync?.handle(m);
    },
    call: (call) => voice.incoming(call),
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
$('srcForm').onsubmit = (e) => {
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
