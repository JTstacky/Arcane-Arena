# Online multiplayer: how it works and how to reuse it

This is the multiplayer stack shared by the Teng Games titles (Arcane Arena and Hammerguy's Party). Everything described here lives in `engine/`, which each game repo carries its own copy of. A new game gets all of it by copying `engine/` and following **Making a new game multiplayer** below.

It covers:
- how players find and reach each other;
- how the game state reaches them quickly and cheaply;
- how each player's own hero responds instantly;
- every setting, URL option and constant involved.

---

## The big picture

```
                 tenggames.com.au (GitHub Pages: static files only)
                 ├── /<game>/        the game (HTML + JS)
                 └── /relay.json     {"url":"wss://tenggames-relay.….workers.dev"}

  HOST's browser                                   GUEST's browser
  ┌──────────────────────────────┐                 ┌────────────────────────┐
  │ page: rendering, input       │                 │ page: rendering, input │
  │   net.js P2PHost             │                 │   net.js P2PClient     │
  │ Web Worker: room + game sim  │◄── WebRTC ─────►│   SnapDecoder          │
  │   (hub.js, room.js, game)    │  (direct/TURN)  │   Predictor            │
  │   SnapEncoder per guest      │                 └────────────────────────┘
  └──────────────┬───────────────┘                          ▲
                 │  WebSocket (fallback)                    │ WebSocket
                 ▼                                          │
        Cloudflare Worker "tenggames-relay" ────────────────┘
        (one Durable Object per game code; forwards, never reads)

  PeerJS cloud server (0.peerjs.com): only introduces peers for WebRTC.
```

- **The host runs the game.** The player who clicks *Host a game* is the host, like a Warcraft III host. Their browser runs the lobby, the room and the simulation in a Web Worker. Browsers slow down timers in background tabs but not in workers, so the game keeps full speed when the host alt-tabs.
- **The host is authoritative.** Guests send orders (`{t:'cmd', …}`) and draw what the host tells them.
- **There is no game server.**
  - The website is static files on GitHub Pages.
  - PeerJS's free cloud server is only a matchmaker for WebRTC.
  - The Cloudflare relay is a dumb pipe, used only when a direct connection fails.
- **The same room code runs everywhere.** `engine/server/room.js` and `hub.js` run unchanged in the host's worker and in the optional Node server (`server.js`, for development or self-hosting).

## Joining: direct first, relay as a fallback

| Step | What happens | Where |
|---|---|---|
| 1 | The host's page starts the worker, and registers with PeerJS as `<prefix>-<CODE>`, e.g. `tenggames-arcane-arena-ABCD`. **At the same time** it opens a WebSocket to the relay at `wss://<relay>/<prefix>/<CODE>?role=host`. The room opens as soon as either is ready. | `P2PHost.boot()` |
| 2 | A guest with the code dials the host over WebRTC through PeerJS. ICE tries a direct path (STUN), then TURN relays. | `P2PClient.dialDirect()` |
| 3 | If the data channel hasn't opened within **5 s** (`DIRECT_MS`), or PeerJS says the peer doesn't exist or can't be reached, the guest switches to the relay: `wss://<relay>/<prefix>/<CODE>?role=guest`. | `P2PClient.useRelay()` |
| 4 | Both paths end in the same place: the guest sends `{t:'join', code, name, token}`, and the host's room replies `welcome` then `lobby`. | `hub.js`, `room.js` |

- **Rejoining.** Each browser keeps a random token in `localStorage` (`tenggames-token`), and a refresh rejoins automatically. The same token gets the same seat back, even mid-game.
- **Losing the host.** If the host's tab closes, guests get `hostLeft`, which comes from relay close code 4410 or from the data channel closing and no redial succeeding.

### Why a relay
- Some networks can't make direct WebRTC connections: mobile data, carrier-grade NAT, school and office wifi.
- The free TURN servers that are meant to cover this are unreliable, so those players were stuck on "Connecting to host".
- The relay uses a plain WebSocket over port 443, which works anywhere the website loads.
- It adds only a few milliseconds when players are in the same region, because Cloudflare places the room near the host.

## Getting the game state to players

### Snapshots
Every tick, the host's room calls `game.tick(dt)`:
- **Arcane Arena** ticks at 33⅓ Hz, **Hammerguy's Party** at 30 Hz (`TICK_RATE` in `engine/shared/constants.js`).
- Every `SNAPSHOT_EVERY` (2) ticks, the room builds each player's snapshot with `game.snapshot(playerId)`.
- The room adds `tk` (the tick number) and `ev` (the one-shot events for that player).
- The host's own page gets snapshots through the worker with no network cost. In Hammerguy's Party it gets one every tick (`conn.fast`).

### Compression: deltas against an acknowledged baseline (`engine/shared/snapcodec.js`)
Each guest connection in the host worker has a `SnapEncoder`, and each guest has a `SnapDecoder`.

- **Deltas.** A snapshot is sent as the *difference* from an earlier snapshot the guest is known to have. The diff is generic JSON with no per-game schema:
  - objects are diffed key by key;
  - arrays of `{id,…}` objects are matched by `id`;
  - other arrays are diffed by index.
- **Measured on real bot games:**

  | Game | Full snapshot | Delta |
  |---|---|---|
  | Arcane Arena | ~2.4 KB | ~70–220 B |
  | Hammerguy's Party | ~1.4 KB | ~230–400 B |

- **How the host knows a guest has a snapshot:**
  - Over a **reliable** transport (the relay WebSocket, or the reliable data channel), every snapshot sent counts as received (`ackOnSend`).
  - Over the **lossy** channel (below), the guest acknowledges with a tiny `a<seq>` message. The host builds only on acknowledged snapshots.
- **Stalled guests.** If a guest stops acknowledging (a lost channel, or a page stalled building a new map), deltas continue against the old baseline for 100 snapshots (about 6 s). After that the host sends whole snapshots, reliably, until it catches up.
- **Events (`snap.ev`)** are never diffed. Each gets a sequence number and is repeated in every snapshot until one carrying it is known to have arrived. The decoder drops repeats, so every event is delivered exactly once, in order, even when snapshots are lost.

Wire format: `{t:'d', s, b?, d, e?, a?}`. The top of `snapcodec.js` documents it in full.

### The lossy channel (direct connections only)
- **The problem.** PeerJS data channels are reliable and ordered. One lost packet on wifi or mobile holds up every snapshot behind it until it is resent, which shows up as stutter.
- **The fix.** Once a direct connection opens, both sides open a second WebRTC data channel on the same connection:
  `createDataChannel('snap', { negotiated: true, id: 7, ordered: false, maxRetransmits: 0 })`.
- **What it's for.** Snapshot deltas go over this channel, never resent and never waiting on each other. A lost one is simply replaced by the next, 60 ms later.
- **Everything else** stays on the reliable channel: lobby, chat, orders, and whole snapshots.
- **No extra signalling.** "Negotiated" means both sides just open the same channel id.
- **Relayed guests** stay on TCP (WebSocket), so this can't apply to them; they still get the compression.

### Congestion
- If a guest's send buffer backs up past 64 KB (`BACKLOG`), the host page tells the worker that the connection is `busy`.
- While busy, snapshots to that guest are skipped rather than queued behind stale state. Their events wait for the next snapshot.
- The page tells the worker again once the buffer drains.

### Smooth motion on the guest
- Snapshots are played back slightly in the past and interpolated.
- **Arcane Arena** uses a fixed 110 ms delay.
- **Hammerguy's Party** adapts the delay to the measured snapshot interval and jitter, between 40 and 250 ms.
- Clocks are synced from snapshot arrival times (`World.pushSnapshot`).

## Instant response: client-side prediction (`engine/client/predict.js`)
The player's own hero is drawn where it *will* be once their orders reach the host, instead of a round trip later.

1. **Tag orders.** The client tags each order with a sequence number `q` and remembers when it sent it.
2. **Send movement state.** Each snapshot includes `me.pr`, the hero's exact movement state, with:
   - `sq`, the newest order the host has handled;
   - `sk` in Hammerguy's Party, the tick that order first took part in.
3. **Re-run the host's movement.** The client re-runs the host's own movement code (`stepUnits` from `engine/server/sim.js`) from that state. It replays the orders the host hasn't handled yet at the moments they'll arrive, up to "now plus one round trip".
4. **Blend out surprises.** Anything the client can't foresee arrives in the next snapshot, such as a knockback, a collision or a teleport. The difference is blended out over a few frames, or snapped if it's more than 3 m.

**Per game:**
- **Arcane Arena:** predicts walking, turning, casting and dashes.
- **Hammerguy's Party:**
  - predicts walking, joystick steering, the minigame's arena walls, and cast points;
  - also predicts the start of abilities that need no target picking;
  - abilities that target a unit, and attacks, start when the host says so;
  - a minigame that moves heroes its own way sets `this.predict = false`.

Tests (`test/predict.test.js`) check the forecast against the real host at 1, 50 and 120 ms one-way latency.

---

## Settings reference

### URL options (for testing; add to the game's address)
| Option | Effect |
|---|---|
| `?room=ABCD` | Pre-fills the join code. This is what invite links use. |
| `?net=relay` | Skip the direct attempt and always use the relay (host and guests). |
| `?relay=wss://…` | Use a different relay. `?relay=off` turns the relay off. |
| `?transport=ws` | Use the optional Node server at `/ws` instead of peer-to-peer. |
| `?touch=1` / `?touch=0` | Force phone controls on or off for this browser session. |

### Build-time environment variables (Vite)
| Variable | Default | Effect |
|---|---|---|
| `VITE_RELAY_URL` | *(none)* | Relay address when `/relay.json` isn't available. |
| `VITE_ICE_SERVERS` | *(none)* | JSON array of extra `RTCIceServer`s (your own TURN), tried first. |
| `VITE_PEER_HOST`, `VITE_PEER_PORT`, `VITE_PEER_PATH`, `VITE_PEER_SECURE` | PeerJS cloud | Use your own PeerJS server, e.g. `npx peerjs --port 9000` for local tests. |
| `VITE_TRANSPORT` | `p2p` | `ws` builds a site that uses the Node server. |

### Site files
- **`/relay.json`** at the site root holds `{"url":"wss://…"}`.
  - The games fetch it at startup, so the relay can move without rebuilding any game.
  - The site repo's *Deploy multiplayer relay* workflow writes it.
- **Local testing:** a game served without `/relay.json` just uses direct connections.

### The relay (site repo, `relay/`)
- **What it is:** a Cloudflare Worker, `tenggames-relay`, with one Durable Object (`Room`) per `<game>/<CODE>`. Its protocol is documented at the top of `relay/src/index.js`.
- **Messages:**
  - The host receives `+id` / `-id` as guests join and leave, and `id|message` for what they send.
  - The host sends `[[id, message], …]` batches (one frame per tick for all guests), or `x|id` to disconnect a guest.
  - `~` is a heartbeat, answered without waking the Durable Object.
- **Close codes:**
  - 4404: no game with that code;
  - 4409: code already hosted (the host picks a new code);
  - 4410: the host left;
  - 4403: origin not allowed.
- **`ALLOWED_ORIGINS`** in `relay/wrangler.toml` lists which sites may use it: tenggames.com.au, jtstacky.github.io and localhost.
- **Deploying:** the GitHub secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then the *Deploy multiplayer relay* workflow. The workflow also runs whenever `relay/` changes.
- **Cost:** Cloudflare's free plan is plenty, because the relay is used only by players who can't connect directly.

### Constants
| Constant | Value | Where | Meaning |
|---|---|---|---|
| `TICK_RATE` | 33⅓ / 30 | `engine/shared/constants.js` | Simulation ticks per second (Arcane / Party). |
| `SNAPSHOT_EVERY` | 2 | same | Ticks per network snapshot (~16 per second). |
| `MAX_PLAYERS` | 10 | same | Room size. |
| `DIRECT_MS` | 5000 | `engine/client/net.js` | How long a direct connection gets before the relay is tried. |
| `DIAL_TIMEOUT_MS`, `DIAL_ATTEMPTS` | 15000, 3 | same | Direct-only retries, used when there's no relay. |
| `RELAY_OPEN_MS` | 12000 | same | Relay connection timeout. |
| `HEARTBEAT_MS` | 25000 | same | Relay keep-alive. |
| `BACKLOG` | 65536 | same | Send buffer bytes before snapshots are skipped. |
| `LOSSY_ID` | 7 | same | Data channel id of the snapshot channel. |
| `DEFAULT_ICE_SERVERS` | Google/Cloudflare STUN, PeerJS + OpenRelay TURN | same | How WebRTC finds a path. |
| `MAX_AGE`, `HISTORY` | 100, 128 | `engine/shared/snapcodec.js` | Oldest usable baseline; decoder history. |
| `MAX_STEPS`, `SNAP_DIST`, `BLEND` | 24, 3 m, 12/s | `engine/client/predict.js` | Prediction horizon; jump threshold; correction blend speed. |
| `INTERP_DELAY` / `DELAY_MIN…MAX` | 110 ms / 40–250 ms | `engine/client/render/world.js` | Interpolation delay (Arcane fixed / Party adaptive). |

---

## Making a new game multiplayer

1. **Copy `engine/`** from either game repo; Hammerguy's Party's copy is the more general one. Keep `engine/shared/snapcodec.js`, `engine/client/net.js`, `host-worker-core.js`, `server/hub.js` and `server/room.js` as they are.
2. **Write the game class.** The room creates it with `new Game(room, settings)` and calls:
   - `tick(dt)`: advance the simulation.
   - `snapshot(playerId)`: return a plain JSON object. Follow the rules below.
   - `command(playerId, m)`: a player's order (`m.t === 'cmd'`).
   - `events`: an array the room empties each snapshot. Push one-shot things here (sounds, explosions, messages), each `{ k: 'kind', …, to?: playerId }`.
   - `over`: set true when the match ends.
   - `mapInfo`: `{ v, … }`; bump `v` to broadcast a new map.
   - `mode`: a name sent to clients with `start`.
3. **Snapshot rules:**
   - Give every entity in an array an `id`. It is matched by id, so an entity that moves costs a few bytes rather than being re-sent.
   - Round numbers (`round2`) so unchanged values stay identical and aren't re-sent.
   - Put one-shot things in `ev`, never in the state. Only events are guaranteed to arrive; a lost snapshot is replaced by the next one.
   - Don't use `-` as an object key: the codec uses it to mark removed keys.
4. **Add a game definition** (`game.js`): `{ id, title, options, defaults, Game }`.
5. **Add a worker entry** (`client/host-worker.js`): `runHostWorker(gameDef)`.
6. **Start the client:**

   ```js
   startApp({
     …,
     p2p: {
       prefix: 'tenggames-<game-id>',
       createWorker: () => new Worker(new URL('./host-worker.js', import.meta.url), { type: 'module' }),
     },
   });
   ```

   The prefix must be unique per game, since it namespaces game codes on PeerJS and the relay.
7. **Optional: prediction.** Put `me: { uid, pr }` in each snapshot, where `pr` is the hero's movement state plus `sq` (and `sk`); see `predictState` in either game. Use Hammerguy's Party's `predict.js` as the template.
8. **Deploy** the game into the site repo like the others:
   - add it to `scripts/update-games.sh`, run the script, and push;
   - it gets the relay automatically, since `/relay.json` is shared and the relay accepts any game prefix.

## Testing locally
```bash
npm test                                   # unit + multiplayer tests (incl. snapcodec, predict)
npx peerjs --port 9000                     # a local PeerJS server (npm i -g peer)
VITE_PEER_HOST=localhost VITE_PEER_PORT=9000 VITE_PEER_SECURE=false npx vite build
cd ../Chess-tutor/relay && npx wrangler dev --port 8787 --var ALLOWED_ORIGINS:'*'
# serve dist/ plus a relay.json of {"url":"ws://127.0.0.1:8787"}; open two windows
```
- Add `?net=relay` to force the relay path.
- A Chromium started with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` can't connect directly, which simulates a strict network and exercises the automatic fallback.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| Stuck on "Connecting to the host…" | Direct connection blocked and no relay. Check `/relay.json` loads and the relay's `/health` answers. |
| "Could not reach the matchmaking server" | Both PeerJS and the relay are unreachable from the host (offline, or a firewall). |
| Console: "The relay does not accept this page's address" | The page's origin is missing from `ALLOWED_ORIGINS` in `relay/wrangler.toml`. |
| Guests lag only when the host is on a phone | The host's upload or CPU. Snapshots are now small, but the host still sends one per guest. |
| Own hero jitters against walls | The walls aren't mirrored in prediction. Use `clampToRect`/`clampToCircle` (which record the arena) or add them to `predict.js`. |
