// Client networking. Two transports behind one interface:
//
//  - 'p2p' (default for the static site): no game server at all. The player
//    who creates a game becomes the host, like a Warcraft III game host: their
//    browser runs the room and simulation in a Web Worker, and friends
//    connect straight to them over WebRTC data channels (PeerJS). A public
//    PeerJS signalling server only introduces the peers to each other.
//  - 'ws': talk to the optional Node server (games/<id>/server.js).
//
// The browser remembers a random token so a refresh or dropped connection
// puts you back in your seat.

import { Peer } from 'peerjs';
import { randomCode } from '../server/hub.js';
import { SnapDecoder } from '../shared/snapcodec.js';

const TOKEN_KEY = 'tenggames-token';

function token() {
  try {
    let t = localStorage.getItem(TOKEN_KEY);
    if (!t) {
      t = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(TOKEN_KEY, t);
    }
    return t;
  } catch {
    return Math.random().toString(36).slice(2);
  }
}

// How peers reach each other across the internet. STUN lets most home
// routers connect directly; players behind stricter networks (mobile data,
// school or office wifi, "carrier-grade" NAT) need a TURN relay. PeerJS's own
// free relays only speak UDP on port 3478, which such networks often block,
// so relays over TCP/TLS on ports 80 and 443 are listed too. Set
// VITE_ICE_SERVERS (a JSON array of RTCIceServer objects, e.g. from a free
// Metered.ca or Cloudflare TURN account) at build time to add your own relay;
// it is tried first.
const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
  {
    urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443?transport=tcp', 'turns:openrelay.metered.ca:443?transport=tcp'],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

export function iceServers() {
  const extra = import.meta.env?.VITE_ICE_SERVERS;
  if (extra) {
    try {
      const list = JSON.parse(extra);
      if (Array.isArray(list) && list.length) return [...list, ...DEFAULT_ICE_SERVERS];
    } catch {
      console.warn('VITE_ICE_SERVERS is not valid JSON; using the default relays');
    }
  }
  return DEFAULT_ICE_SERVERS;
}

// How long a guest waits for the host's data channel to open before trying
// again: a relayed connection can take several seconds to set up.
const DIAL_TIMEOUT_MS = 15000;
const DIAL_ATTEMPTS = 3;

// PeerJS settings; override with VITE_PEER_* at build time to use your own
// signalling server (e.g. `npx peerjs --port 9000`).
function peerOptions() {
  const env = import.meta.env || {};
  const o = { debug: 1, config: { iceServers: iceServers(), sdpSemantics: 'unified-plan' } };
  if (env.VITE_PEER_HOST) {
    o.host = env.VITE_PEER_HOST;
    o.port = +(env.VITE_PEER_PORT || 443);
    o.path = env.VITE_PEER_PATH || '/';
    o.secure = env.VITE_PEER_SECURE !== 'false';
  }
  return o;
}

export class Net {
  // p2p: { prefix, createWorker }
  constructor(onMessage, onStatus, { transport = 'p2p', p2p } = {}) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.transport = transport;
    this.p2p = p2p;
    this.impl = null;
  }

  get isHost() {
    return this.impl instanceof P2PHost;
  }

  connect(hello) {
    this.close();
    const h = { ...hello, token: token() };
    if (this.transport === 'ws') this.impl = new WsClient(h, this);
    else if (h.t === 'create') this.impl = new P2PHost(h, this);
    else this.impl = new P2PClient(h, this);
  }

  send(m) {
    this.impl?.send(m);
  }

  close() {
    this.impl?.close();
    this.impl = null;
  }
}

// ------------------------------------------------------------------ ws

class WsClient {
  constructor(hello, net) {
    this.net = net;
    this.hello = hello;
    this.retry = 0;
    this.closed = false;
    this.open();
  }

  open() {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const base = location.pathname.replace(/[^/]*$/, '');
    const ws = new WebSocket(`${proto}://${location.host}${base}ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.net.onStatus('open');
      ws.send(JSON.stringify(this.hello));
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      // Once in a room, reconnects rejoin that room.
      if (m.t === 'welcome') this.hello = { t: 'join', code: m.code, name: this.hello.name, token: this.hello.token };
      this.net.onMessage(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.closed) return;
      this.net.onStatus('closed');
      if (this.hello.t === 'join' && this.retry < 8) {
        this.retry++;
        this.retryTimer = setTimeout(() => this.open(), Math.min(4000, 500 * this.retry));
      }
    };
  }

  send(m) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}

// ----------------------------------------------------------------- p2p

// The relay (see relay/ in the Teng Games site repo): a Cloudflare Worker
// that forwards messages between the host and guests when a direct WebRTC
// connection can't be made. Its address comes from /relay.json on the site
// (so it can change without rebuilding the games), VITE_RELAY_URL at build
// time, or ?relay=wss://… in the page URL for testing (?relay=off disables it).
// ?net=relay skips the direct attempt and always uses the relay.
let relayPromise = null;
export function relayUrl() {
  if (!relayPromise) {
    relayPromise = (async () => {
      const q = new URLSearchParams(location.search).get('relay');
      if (q) return q === 'off' ? null : q.replace(/\/$/, '');
      const env = import.meta.env?.VITE_RELAY_URL;
      if (env) return env.replace(/\/$/, '');
      try {
        const r = await fetch('/relay.json', { cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          if (typeof j.url === 'string' && /^wss?:\/\//.test(j.url)) return j.url.replace(/\/$/, '');
        }
      } catch {}
      return null;
    })();
  }
  return relayPromise;
}

const RELAY_ONLY = typeof location !== 'undefined' && new URLSearchParams(location.search).get('net') === 'relay';
const DIRECT_MS = 5000; // how long a direct connection gets before trying the relay
const RELAY_OPEN_MS = 12000;
const HEARTBEAT_MS = 25000;
const BACKLOG = 65536; // bytes queued before snapshots are skipped
const LOSSY_ID = 7; // data channel id of the snapshot channel

// A second channel on the same WebRTC connection, for snapshots: unordered
// and never resent, so a lost packet doesn't hold up the ones behind it the
// way it does on PeerJS's reliable channel (a newer snapshot will be along in
// 60 ms anyway). "negotiated" means both sides simply open it with the same
// id, so it needs no extra signalling. Snapshots that are lost are handled by
// the snapshot codec (shared/snapcodec.js).
function lossyChannel(dc) {
  try {
    return dc.peerConnection?.createDataChannel('snap', { negotiated: true, id: LOSSY_ID, ordered: false, maxRetransmits: 0 }) || null;
  } catch {
    return null;
  }
}

// The hosting player's side. The room runs in a Web Worker: browsers throttle
// timers on background tabs, but not in workers, so the game keeps running
// at full speed if the host alt-tabs. Guests reach it directly over WebRTC
// (PeerJS) or, when that fails, through the relay; the host listens on both.
class P2PHost {
  constructor(hello, net) {
    this.net = net;
    this.hello = hello;
    this.conns = new Map(); // conn id -> { send(data), close(), backlog() }
    this.nextConn = 1;
    this.boot(0);
  }

  boot(attempt) {
    this.attempt = attempt;
    this.code = randomCode();
    this.started = false;
    this.peerDown = RELAY_ONLY;
    this.relayDown = false;
    this.worker = this.net.p2p.createWorker();
    this.worker.onmessage = (e) => this.fromWorker(e.data);
    this.worker.onerror = (e) => {
      console.error('Host worker error', e);
      this.net.onMessage({ t: 'error', text: 'The game host crashed. Please reload.' });
    };
    if (!RELAY_ONLY) this.startPeer();
    relayUrl().then((url) => {
      if (this.closed || this.attempt !== attempt) return;
      this.relayBase = url;
      if (url) this.openRelay();
      else this.relayFailed();
    });
  }

  // The room opens as soon as either way in (direct or relay) is ready.
  start() {
    if (this.started) return;
    this.started = true;
    this.worker.postMessage({ type: 'init', code: this.code });
    this.worker.postMessage({ type: 'open', conn: 'local', local: true });
    this.send(this.hello);
    this.net.onStatus('open');
  }

  // Someone else is already hosting this code: start over with a new one.
  restart() {
    if (this.attempt >= 5 || [...this.conns.keys()].length) return;
    this.teardown();
    this.boot(this.attempt + 1);
  }

  startPeer() {
    const peer = new Peer(`${this.net.p2p.prefix}-${this.code}`, peerOptions());
    this.peer = peer;
    peer.on('open', () => {
      this.peerDown = false;
      this.start();
    });
    peer.on('connection', (dc) => this.acceptPeer(dc));
    peer.on('disconnected', () => {
      // Lost the signalling server: keep hosting, and reconnect so new
      // players can still join directly. Existing players are unaffected.
      if (!this.closed && this.peer === peer) setTimeout(() => !this.closed && !peer.destroyed && peer.reconnect(), 1500);
    });
    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      if (err.type === 'unavailable-id') this.restart();
      else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
        this.peerDown = true;
        if (this.relayDown) this.unreachable();
      } else if (err.type !== 'peer-unavailable') console.warn('PeerJS error', err);
    });
  }

  acceptPeer(dc) {
    const id = String(this.nextConn++);
    dc.on('open', () => {
      const lc = lossyChannel(dc);
      this.conns.set(id, {
        send: (d) => dc.send(d),
        sendLossy: (d) => (lc?.readyState === 'open' ? lc.send(d) : dc.send(d)),
        close: () => {
          lc?.close();
          dc.close();
        },
        backlog: () => (dc.bufferSize > 0 ? Infinity : dc.dataChannel?.bufferedAmount || 0),
      });
      this.worker.postMessage({ type: 'open', conn: id });
      if (lc) {
        lc.onopen = () => this.conns.has(id) && this.worker.postMessage({ type: 'lossy', conn: id, on: true });
        lc.onclose = () => this.conns.has(id) && this.worker.postMessage({ type: 'lossy', conn: id, on: false });
        lc.onmessage = (e) => this.conns.has(id) && this.worker.postMessage({ type: 'message', conn: id, data: String(e.data) });
      }
    });
    dc.on('data', (data) => this.worker.postMessage({ type: 'message', conn: id, data: String(data) }));
    dc.on('close', () => this.gone(id));
    dc.on('error', () => this.gone(id));
  }

  openRelay() {
    const ws = new WebSocket(`${this.relayBase}/${this.net.p2p.prefix}/${this.code}?role=host`);
    this.rws = ws;
    ws.onopen = () => {
      this.relayDown = false;
      this.start();
      clearInterval(this.beat);
      this.beat = setInterval(() => ws.readyState === 1 && ws.send('~'), HEARTBEAT_MS);
    };
    ws.onmessage = (e) => {
      const s = String(e.data);
      if (s === '~') return;
      if (s[0] === '+') {
        const gid = s.slice(1);
        const id = `r${gid}`;
        this.conns.set(id, {
          send: (d) => this.relaySend(+gid, d),
          close: () => ws.readyState === 1 && ws.send(`x|${gid}`),
          backlog: () => ws.bufferedAmount,
        });
        this.worker.postMessage({ type: 'open', conn: id });
      } else if (s[0] === '-') {
        this.gone(`r${s.slice(1)}`);
      } else {
        const i = s.indexOf('|');
        if (i > 0) this.worker.postMessage({ type: 'message', conn: `r${s.slice(0, i)}`, data: s.slice(i + 1) });
      }
    };
    ws.onclose = (e) => {
      if (this.rws !== ws) return;
      clearInterval(this.beat);
      for (const id of [...this.conns.keys()]) if (id[0] === 'r') this.gone(id);
      if (this.closed) return;
      if (e.code === 4409) return this.restart();
      if (e.code === 4403) console.warn('The relay does not accept this page\'s address (ALLOWED_ORIGINS).');
      if (!this.started) {
        this.relayDown = true;
        if (this.peerDown) this.unreachable();
      }
      // Keep trying: relayed players reconnect and rejoin their seats.
      setTimeout(() => !this.closed && this.rws === ws && this.openRelay(), 3000);
    };
  }

  // Everything sent to relayed guests in one turn goes out as one frame.
  relaySend(gid, data) {
    (this.rq ||= []).push([gid, data]);
    if (this.rqTimer) return;
    this.rqTimer = setTimeout(() => {
      this.rqTimer = 0;
      const q = this.rq;
      this.rq = [];
      if (this.rws?.readyState === 1 && q.length) this.rws.send(JSON.stringify(q));
    }, 0);
  }

  relayFailed() {
    this.relayDown = true;
    if (this.peerDown) this.unreachable();
  }

  unreachable() {
    if (this.started || this.closed) return;
    this.net.onMessage({ t: 'error', text: 'Could not reach the matchmaking server. Check your internet connection and try again.', fatal: true });
  }

  gone(id) {
    if (!this.conns.has(id)) return;
    this.conns.delete(id);
    this.worker.postMessage({ type: 'closed', conn: id });
  }

  fromWorker(m) {
    if (m.type === 'send') {
      if (m.conn === 'local') return this.net.onMessage(JSON.parse(m.data));
      const c = this.conns.get(m.conn);
      if (!c) return;
      if (m.lossy && c.sendLossy) c.sendLossy(m.data);
      else c.send(m.data);
      this.checkBusy(m.conn, c);
    } else if (m.type === 'close') {
      this.conns.get(m.conn)?.close();
    }
  }

  // A player whose send buffer backs up skips snapshots (the worker keeps
  // their events for the next one) rather than queueing stale state; it's
  // told when the buffer has drained.
  checkBusy(id, c) {
    const busy = c.backlog() > BACKLOG;
    if (busy === !!c.busy) return;
    c.busy = busy;
    this.worker.postMessage({ type: 'busy', conn: id, on: busy });
    if (!busy) return;
    const poll = setInterval(() => {
      if (this.closed || this.conns.get(id) !== c) return clearInterval(poll);
      if (c.backlog() > BACKLOG) return;
      clearInterval(poll);
      this.checkBusy(id, c);
    }, 50);
  }

  send(m) {
    this.worker.postMessage({ type: 'message', conn: 'local', data: JSON.stringify(m) });
  }

  teardown() {
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    clearInterval(this.beat);
    this.worker?.terminate();
    this.peer?.destroy();
    const ws = this.rws;
    this.rws = null;
    ws?.close();
  }

  close() {
    this.closed = true;
    this.teardown();
  }
}

// A player joining someone else's game: directly over WebRTC when possible,
// otherwise through the relay.
class P2PClient {
  constructor(hello, net) {
    this.net = net;
    this.hello = hello;
    this.retry = 0; // redials after losing an established connection
    this.attempt = 0; // direct dials that never opened (no relay available)
    this.mode = RELAY_ONLY ? 'relay' : 'direct';
    net.onStatus('connecting');
    relayUrl().then((url) => {
      this.relayBase = url;
      if (!this.closed) this.dial();
    });
  }

  get code() {
    return String(this.hello.code).toUpperCase();
  }

  dial() {
    if (this.closed) return;
    this.net.onStatus(this.joined ? 'reconnecting' : 'connecting');
    if (this.mode === 'relay') this.dialRelay();
    else this.dialDirect();
  }

  // Switches to the relay (once); false if there is none.
  useRelay() {
    if (!this.relayBase) return false;
    if (this.mode === 'relay') return true;
    this.mode = 'relay';
    clearTimeout(this.dialTimer);
    const dc = this.dc;
    this.dc = null;
    this.dropLossy();
    dc?.close();
    this.peer?.destroy();
    this.peer = null;
    this.dialRelay();
    return true;
  }

  dialDirect() {
    if (!this.peer || this.peer.destroyed) {
      const peer = new Peer(peerOptions());
      this.peer = peer;
      peer.on('disconnected', () => {
        if (!this.closed && this.peer === peer) setTimeout(() => !this.closed && !peer.destroyed && peer.reconnect(), 1000);
      });
      peer.on('error', (err) => {
        if (this.peer !== peer || this.closed) return;
        if (err.type === 'peer-unavailable') {
          // The host may only be reachable through the relay.
          clearTimeout(this.dialTimer);
          if (this.useRelay()) return;
          if (this.joined) this.lost();
          else this.fail('No game with that code — or its host has left.');
        } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
          if (this.useRelay()) return;
          if (!this.joined) this.fail('Could not reach the matchmaking server. Check your internet connection and try again.');
        } else console.warn('PeerJS error', err);
      });
    }
    const peer = this.peer;
    const go = () => {
      if (this.peer !== peer || this.closed) return;
      const dc = peer.connect(`${this.net.p2p.prefix}-${this.code}`, { reliable: true, serialization: 'raw' });
      this.dc = dc;
      // A direct connection that hasn't opened in a few seconds won't: the
      // networks in between block it. Use the relay instead.
      clearTimeout(this.dialTimer);
      this.dialTimer = setTimeout(() => {
        if (this.dc !== dc || dc.open || this.closed) return;
        if (this.useRelay()) return;
        this.dc = null;
        dc.close();
        this.attempt++;
        if (this.attempt < DIAL_ATTEMPTS) this.dial();
        else if (this.joined) this.lost();
        else this.fail("Couldn't connect to the host's game. One of your networks may be blocking direct connections (common on school, office or some mobile networks). Try again, try another network, or let someone else host.");
      }, this.relayBase ? DIRECT_MS : DIAL_TIMEOUT_MS);
      dc.on('open', () => {
        if (this.dc !== dc) return dc.close();
        clearTimeout(this.dialTimer);
        this.opened();
        this.dropLossy();
        const lc = lossyChannel(dc);
        this.lc = lc;
        if (lc) lc.onmessage = (e) => this.dc === dc && this.receive(String(e.data));
        dc.send(JSON.stringify(this.hello));
      });
      dc.on('data', (data) => this.dc === dc && this.receive(String(data)));
      dc.on('close', () => {
        if (this.dc !== dc || this.closed) return;
        this.dropLossy();
        this.lost();
      });
    };
    if (peer.open) go();
    else peer.once('open', go);
  }

  dialRelay() {
    const ws = new WebSocket(`${this.relayBase}/${this.net.p2p.prefix}/${this.code}?role=guest`);
    this.ws = ws;
    let open = false;
    clearTimeout(this.dialTimer);
    this.dialTimer = setTimeout(() => {
      if (this.ws === ws && !open) ws.close();
    }, RELAY_OPEN_MS);
    ws.onopen = () => {
      if (this.ws !== ws) return ws.close();
      open = true;
      clearTimeout(this.dialTimer);
      this.opened();
      ws.send(JSON.stringify(this.hello));
      clearInterval(this.beat);
      this.beat = setInterval(() => ws.readyState === 1 && ws.send('~'), HEARTBEAT_MS);
    };
    ws.onmessage = (e) => {
      const s = String(e.data);
      if (s !== '~' && this.ws === ws) this.receive(s);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws || this.closed) return;
      clearTimeout(this.dialTimer);
      clearInterval(this.beat);
      this.ws = null;
      if (e.code === 4410) {
        this.net.onMessage({ t: 'hostLeft' });
        return this.close();
      }
      if (e.code === 4404) {
        if (this.joined) return this.lost();
        return this.fail('No game with that code — or its host has left.');
      }
      if (!open && !this.joined) return this.fail("Couldn't reach the game. Check your internet connection and try again.");
      this.lost();
    };
  }

  opened() {
    this.retry = 0;
    this.attempt = 0;
    // Each connection is a new snapshot stream from the host.
    this.dec = new SnapDecoder();
    this.net.onStatus('open');
  }

  dropLossy() {
    this.lc?.close();
    this.lc = null;
  }

  receive(data) {
    const m = JSON.parse(data);
    if (m.t === 'd') {
      // A compressed snapshot (shared/snapcodec.js).
      const snap = this.dec?.decode(m);
      if (!snap) return;
      // Over the lossy channel the host only builds on snapshots we confirm.
      if (m.a) this.sendRaw(`a${m.s}`, true);
      return this.net.onMessage(snap);
    }
    if (m.t === 'welcome') {
      this.joined = true;
      this.hello = { t: 'join', code: m.code, name: this.hello.name, token: this.hello.token };
    }
    this.net.onMessage(m);
  }

  fail(text) {
    clearTimeout(this.dialTimer);
    this.net.onStatus('failed');
    this.net.onMessage({ t: 'error', text, fatal: true });
    this.close();
  }

  lost() {
    this.net.onStatus('closed');
    if (this.retry < 6 && !this.closed) {
      this.retry++;
      setTimeout(() => !this.closed && this.dial(), Math.min(4000, 700 * this.retry));
    } else if (!this.closed) {
      this.net.onMessage({ t: 'hostLeft' });
    }
  }

  send(m) {
    this.sendRaw(JSON.stringify(m));
  }

  sendRaw(data, lossy) {
    if (this.ws?.readyState === 1) this.ws.send(data);
    else if (lossy && this.lc?.readyState === 'open') this.lc.send(data);
    else if (this.dc?.open) this.dc.send(data);
  }

  close() {
    this.closed = true;
    clearTimeout(this.dialTimer);
    clearInterval(this.beat);
    this.dropLossy();
    this.dc?.close();
    this.peer?.destroy();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
