// A room is one lobby + (optionally) one running game. The server is
// authoritative: clients only send orders (move here, cast that there) and the
// room broadcasts snapshots of the simulated world back to everyone.

import { TICK_RATE, SNAPSHOT_EVERY, MAX_PLAYERS, PLAYER_COLORS } from '../shared/constants.js';

const BOT_NAMES = ['Arthus', 'Jaena', 'Thrahl', 'Illidun', 'Tyrandie', 'Rexxor', 'Kaelus', 'Sylvanis', 'Grohm', 'Muradyn', 'Medivv', 'Cairn'];
const GAME_OVER_LINGER = 25; // seconds before returning to the lobby automatically

let nextPlayerId = 1;

// `gameDef` describes the game this room hosts: { id, Game, options, defaults }.
// `options` maps a setting name to its allowed values, e.g. { rounds: [5, 7, 11] }.
export class Room {
  constructor(code, onEmpty, gameDef) {
    this.code = code;
    this.onEmpty = onEmpty;
    this.gameDef = gameDef;
    this.players = new Map();
    this.hostId = null;
    this.settings = { ...gameDef.defaults };
    this.game = null;
    this.loop = null;
    this.tickCount = 0;
    this.overTime = 0;
    this.emptySince = null;
    this.tuning = {};
  }

  // ---------------------------------------------------------------- players

  playerList() {
    return [...this.players.values()].sort((a, b) => a.slot - b.slot);
  }

  freeSlot() {
    const used = new Set([...this.players.values()].map((p) => p.slot));
    for (let i = 0; i < PLAYER_COLORS.length; i++) if (!used.has(i)) return i;
    return -1;
  }

  isBot(id) {
    return !!this.players.get(id)?.bot;
  }

  isConnected(id) {
    const p = this.players.get(id);
    return !!p && (p.bot || p.connected);
  }

  nameOf(id) {
    return this.players.get(id)?.name ?? '???';
  }

  colorOf(id) {
    const p = this.players.get(id);
    return p ? PLAYER_COLORS[p.slot].hex : '#fff';
  }

  join(ws, name, token) {
    // Reconnect: same browser token reclaims its old seat.
    for (const p of this.players.values()) {
      if (!p.bot && p.token && p.token === token) {
        if (p.ws && p.ws !== ws) p.ws.close();
        p.ws = ws;
        p.connected = true;
        p.name = name || p.name;
        this.emptySince = null;
        this.welcome(p);
        this.system(`${p.name} reconnected.`);
        return p;
      }
    }
    if (this.players.size >= MAX_PLAYERS) return { error: 'Room is full.' };
    const slot = this.freeSlot();
    if (slot < 0) return { error: 'Room is full.' };
    const p = { id: nextPlayerId++, name: name || `Player ${slot + 1}`, slot, bot: false, ws, token, connected: true };
    this.players.set(p.id, p);
    if (this.hostId == null || !this.isConnected(this.hostId)) this.hostId = p.id;
    this.emptySince = null;
    this.welcome(p);
    this.system(`${p.name} joined.`);
    this.broadcastLobby();
    return p;
  }

  welcome(p) {
    this.sendTo(p, { t: 'welcome', id: p.id, code: this.code });
    this.sendTo(p, this.lobbyState());
    if (this.game) {
      this.sendTo(p, { t: 'start', mode: this.game.mode });
      this.sendTo(p, { t: 'map', map: this.game.mapInfo });
    }
  }

  leave(p) {
    if (!p) return;
    p.connected = false;
    p.ws = null;
    if (!this.game) {
      this.players.delete(p.id);
      this.system(`${p.name} left.`);
    } else {
      this.system(`${p.name} disconnected.`);
      this.game.onLeave?.(p.id);
    }
    if (this.hostId === p.id) {
      const next = this.playerList().find((q) => !q.bot && q.connected);
      this.hostId = next ? next.id : null;
    }
    if (!this.playerList().some((q) => !q.bot && q.connected)) this.emptySince = Date.now();
    this.broadcastLobby();
  }

  addBot() {
    if (this.game || this.players.size >= MAX_PLAYERS) return;
    const slot = this.freeSlot();
    const used = new Set([...this.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot ${slot + 1}`;
    const p = { id: nextPlayerId++, name, slot, bot: true, connected: true };
    this.players.set(p.id, p);
    this.broadcastLobby();
  }

  kick(id) {
    const p = this.players.get(id);
    if (!p || this.game) return;
    this.players.delete(id);
    if (p.ws) {
      this.sendTo(p, { t: 'kicked' });
      p.ws.close();
    }
    this.broadcastLobby();
  }

  // --------------------------------------------------------------- messages

  handle(p, m) {
    const isHost = p.id === this.hostId;
    switch (m.t) {
      case 'chat': {
        const text = String(m.text || '').slice(0, 200).trim();
        if (text.startsWith('-') && this.command(p, text)) break;
        if (text) this.broadcast({ t: 'chat', from: p.id, name: p.name, c: PLAYER_COLORS[p.slot].hex, text });
        break;
      }
      case 'name':
        if (!this.game) {
          p.name = String(m.name || '').slice(0, 16).trim() || p.name;
          this.broadcastLobby();
        }
        break;
      case 'color': {
        const slot = +m.slot;
        if (!this.game && slot >= 0 && slot < PLAYER_COLORS.length && ![...this.players.values()].some((q) => q.slot === slot)) {
          p.slot = slot;
          this.broadcastLobby();
        }
        break;
      }
      case 'settings':
        if (isHost && !this.game) {
          for (const [key, allowed] of Object.entries(this.gameDef.options || {})) {
            if (m[key] != null && allowed.includes(+m[key])) this.settings[key] = +m[key];
          }
          this.broadcastLobby();
        }
        break;
      case 'addBot':
        if (isHost) this.addBot();
        break;
      case 'kick':
        if (isHost && m.id !== p.id) this.kick(+m.id);
        break;
      case 'start':
        if (isHost && !this.game) this.startGame(m.only);
        break;
      case 'toLobby':
        if (isHost && this.game) this.endGame();
        break;
      case 'cmd':
        if (this.game) this.game.command(p.id, m);
        break;
    }
  }

  // WC3-style chat commands for tuning the movement feel live, e.g. while
  // comparing side by side with the real game. Host only.
  //   -turnrate 0.6   (object-editor radians per 0.03 s step)
  //   -propwindow 60  (degrees)
  //   -castpoint 0.3  (seconds; "-castpoint off" to reset)
  //   -tuning         (show current values)   -tuning reset
  command(p, text) {
    const [cmd, arg] = text.slice(1).toLowerCase().split(/\s+/);
    const known = ['turnrate', 'propwindow', 'castpoint', 'tuning'];
    if (!known.includes(cmd)) return false;
    if (p.id !== this.hostId) {
      this.system('Only the host can change tuning.');
      return true;
    }
    const v = parseFloat(arg);
    if (cmd === 'turnrate' && v > 0 && v <= 5) this.tuning.turnRate = v;
    else if (cmd === 'propwindow' && v >= 0 && v <= 180) this.tuning.propWindow = (v * Math.PI) / 180;
    else if (cmd === 'castpoint') this.tuning.castPoint = arg === 'off' ? undefined : Math.max(0, Math.min(2, v || 0));
    else if (cmd === 'tuning' && arg === 'reset') this.tuning = {};
    const t = this.tuning;
    this.system(`Tuning — turn rate: ${t.turnRate ?? 'default (0.6)'}, propulsion window: ${t.propWindow != null ? Math.round((t.propWindow * 180) / Math.PI) + '°' : 'default (60°)'}, cast point: ${t.castPoint ?? 'default (0.3 s)'}`);
    return true;
  }

  applyTuning() {
    const t = this.tuning;
    if (t.turnRate == null && t.propWindow == null) return;
    for (const u of this.game.units?.() || []) {
      if (t.turnRate != null) u.turnRate = t.turnRate;
      if (t.propWindow != null) u.propWindow = t.propWindow;
    }
  }

  // ------------------------------------------------------------------- game

  startGame(only) {
    this.game = new this.gameDef.Game(this, { ...this.settings, only });
    this.lastMapV = null;
    this.overTime = 0;
    this.broadcast({ t: 'start', mode: this.game.mode });
    this.broadcastLobby();
    // Timers fire late (a 30 ms interval really runs every ~31 ms), so ticks
    // are paced by the wall clock: run as many 0.03 s steps as real time has
    // passed. Otherwise game time drifts behind real time and clients, which
    // play snapshots back in real time, run out of them and stutter.
    const dt = 1 / TICK_RATE; // 0.03 s
    let last = performance.now();
    let acc = 0;
    this.loop = setInterval(() => {
      const now = performance.now();
      acc = Math.min(acc + (now - last) / 1000, dt * 8);
      last = now;
      try {
        while (acc >= dt - 1e-4 && this.game) {
          acc -= dt;
          this.tick(dt);
        }
      } catch (err) {
        console.error(`[room ${this.code}] tick error`, err);
        this.system('The game crashed and was stopped. Sorry!');
        this.endGame();
      }
    }, 5);
  }

  tick(dt) {
    const g = this.game;
    this.applyTuning();
    g.tick(dt);
    if (g.mapInfo.v !== this.lastMapV) {
      this.lastMapV = g.mapInfo.v;
      this.broadcast({ t: 'map', map: g.mapInfo });
    }
    this.tickCount++;
    if (this.tickCount % SNAPSHOT_EVERY === 0) {
      const events = g.events;
      g.events = [];
      for (const p of this.players.values()) {
        if (p.bot || !p.connected) continue;
        const snap = g.snapshot(p.id);
        snap.t = 'snap';
        snap.tk = this.tickCount;
        snap.ev = events.filter((e) => e.to == null || e.to === p.id);
        this.sendTo(p, snap);
      }
    }
    if (g.over) {
      this.overTime += dt;
      if (this.overTime > GAME_OVER_LINGER) this.endGame();
    }
    if (this.emptySince && Date.now() - this.emptySince > 60_000) this.close();
  }

  endGame() {
    clearInterval(this.loop);
    this.loop = null;
    this.game = null;
    // Drop anyone who disconnected during the game.
    for (const p of [...this.players.values()]) if (!p.bot && !p.connected) this.players.delete(p.id);
    this.broadcast({ t: 'end' });
    this.broadcastLobby();
    if (!this.playerList().some((q) => !q.bot)) this.close();
  }

  close() {
    clearInterval(this.loop);
    this.loop = null;
    for (const p of this.players.values()) p.ws?.close();
    this.onEmpty(this);
  }

  // ------------------------------------------------------------- networking

  lobbyState() {
    return {
      t: 'lobby',
      game: this.gameDef.id,
      code: this.code,
      host: this.hostId,
      settings: this.settings,
      inGame: !!this.game,
      players: this.playerList().map((p) => ({ id: p.id, name: p.name, slot: p.slot, bot: p.bot, connected: p.connected })),
    };
  }

  broadcastLobby() {
    this.broadcast(this.lobbyState());
  }

  system(text) {
    this.broadcast({ t: 'chat', system: true, text });
  }

  broadcast(m) {
    const s = JSON.stringify(m);
    for (const p of this.players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(s);
  }

  sendTo(p, m) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(m));
  }
}
