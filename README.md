# akash-vani

Watch a video in sync with one other person. Static site, no backend: peer-to-peer over WebRTC via [PeerJS](https://peerjs.com) and its free public signaling server.

## Use
1. Both open the site and enter the same room code (or open the invite link, which carries `#room`).
2. Each picks a source: a direct mp4/webm URL, or a local file from their own device.
3. Play, pause, seek and speed changes mirror both ways. A banner warns if video durations differ.
4. Chat in the side panel. Optional voice call (mic only) with mute and hang up.

First joiner hosts (peer ID `akash-vani-room-<code>`); second connects. Host sends a time heartbeat every 2 s; guest nudges `playbackRate` for small drift and hard-seeks past 1 s.

## Slow connection / buffering
- While either side buffers (and 10 s after), sync goes loose: gaps up to ~2 s are left alone, nudges kick in beyond that, hard seek only beyond 6 s. A stalled or seeking player is never forced to seek.
- "Download fully first" fetches the whole URL into memory before playing (server must allow CORS).
- "Stream my video to peer" (host only): host's playing video is sent over WebRTC. Needs a local file or a CORS-enabled URL. Peer gets play/pause/seek controls that drive the host.

## Run locally
ES modules need HTTP, not `file://`:
```sh
python3 -m http.server 8000
# open http://localhost:8000 in two tabs
```
`getUserMedia` works on `localhost` and HTTPS only.

## Deploy (GitHub Pages)
1. Push to GitHub, default branch `main`.
2. Repo Settings → Pages → Source: **GitHub Actions**.
3. Push to `main`. `.github/workflows/deploy.yml` publishes the repo root.

## Add a YouTube player later
`js/player.js` documents the player interface (`load/play/pause/seek/setRate/getTime/getRate/getDuration/isPaused/on`). Implement it over the YouTube IFrame API and pass it to `Sync` in `js/main.js`.

## Notes
- Strict NATs may need a TURN server; add `config: { iceServers: [...] }` in `js/net.js`.
- Public signaling server is best-effort; no uptime guarantee.
