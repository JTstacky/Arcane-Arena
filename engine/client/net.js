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

// PeerJS settings; override with VITE_PEER_* at build time to use your own
// signalling server (e.g. `npx peerjs --port 9000`).
function peerOptions() {
  const env = import.meta.env || {};
  const o = { debug: 1 };
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

// The hosting player's side. The room runs in a Web Worker: browsers throttle
// timers on background tabs, but not in workers, so the game keeps running
// at full speed if the host alt-tabs.
class P2PHost {
  constructor(hello, net) {
    this.net = net;
    this.hello = hello;
    this.conns = new Map(); // conn id -> DataConnection
    this.nextConn = 1;
    this.worker = net.p2p.createWorker();
    this.worker.onmessage = (e) => this.fromWorker(e.data);
    this.worker.onerror = (e) => {
      console.error('Host worker error', e);
      net.onMessage({ t: 'error', text: 'The game host crashed. Please reload.' });
    };
    this.start(0);
  }

  start(attempt) {
    this.code = randomCode();
    this.peer = new Peer(`${this.net.p2p.prefix}-${this.code}`, peerOptions());
    this.peer.on('open', () => {
      this.worker.postMessage({ type: 'init', code: this.code });
      this.worker.postMessage({ type: 'open', conn: 'local', local: true });
      this.send(this.hello);
      this.net.onStatus('open');
    });
    this.peer.on('connection', (dc) => this.accept(dc));
    this.peer.on('disconnected', () => {
      // Lost the signalling server: keep hosting, and reconnect so new
      // players can still join. Existing peers are unaffected.
      if (!this.closed) setTimeout(() => !this.closed && this.peer.reconnect(), 1000);
    });
    this.peer.on('error', (err) => {
      if (err.type === 'unavailable-id' && attempt < 5) {
        this.peer.destroy();
        this.start(attempt + 1);
      } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
        this.net.onMessage({ t: 'error', text: 'Could not reach the matchmaking server. Check your connection.' });
      } else if (err.type !== 'peer-unavailable') {
        console.warn('PeerJS error', err);
      }
    });
  }

  accept(dc) {
    const id = String(this.nextConn++);
    dc.on('open', () => {
      this.conns.set(id, dc);
      this.worker.postMessage({ type: 'open', conn: id });
    });
    dc.on('data', (data) => this.worker.postMessage({ type: 'message', conn: id, data: String(data) }));
    const gone = () => {
      if (!this.conns.has(id)) return;
      this.conns.delete(id);
      this.worker.postMessage({ type: 'closed', conn: id });
    };
    dc.on('close', gone);
    dc.on('error', gone);
  }

  fromWorker(m) {
    if (m.type === 'send') {
      if (m.conn === 'local') this.net.onMessage(JSON.parse(m.data));
      else this.conns.get(m.conn)?.send(m.data);
    } else if (m.type === 'close') {
      this.conns.get(m.conn)?.close();
    }
  }

  send(m) {
    this.worker.postMessage({ type: 'message', conn: 'local', data: JSON.stringify(m) });
  }

  close() {
    this.closed = true;
    for (const dc of this.conns.values()) dc.close();
    this.worker.terminate();
    this.peer?.destroy();
  }
}

// A player joining someone else's game.
class P2PClient {
  constructor(hello, net) {
    this.net = net;
    this.hello = hello;
    this.retry = 0;
    this.peer = new Peer(peerOptions());
    this.peer.on('open', () => this.dial());
    this.peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        if (this.joined) this.lost();
        else net.onMessage({ t: 'error', text: 'No game with that code — or its host has left.' });
      } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
        if (!this.joined) net.onMessage({ t: 'error', text: 'Could not reach the matchmaking server. Check your connection.' });
      } else console.warn('PeerJS error', err);
    });
  }

  dial() {
    const code = String(this.hello.code).toUpperCase();
    const dc = this.peer.connect(`${this.net.p2p.prefix}-${code}`, { reliable: true, serialization: 'raw' });
    this.dc = dc;
    dc.on('open', () => {
      this.retry = 0;
      this.net.onStatus('open');
      dc.send(JSON.stringify(this.hello));
    });
    dc.on('data', (data) => {
      const m = JSON.parse(String(data));
      if (m.t === 'welcome') {
        this.joined = true;
        this.hello = { t: 'join', code: m.code, name: this.hello.name, token: this.hello.token };
      }
      this.net.onMessage(m);
    });
    dc.on('close', () => {
      if (this.dc === dc && !this.closed) this.lost();
    });
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
    if (this.dc?.open) this.dc.send(JSON.stringify(m));
  }

  close() {
    this.closed = true;
    this.dc?.close();
    this.peer?.destroy();
  }
}
