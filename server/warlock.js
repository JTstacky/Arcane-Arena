// Warlock — a remake of the classic Warcraft III custom map.
//
// Every player controls a warlock on a platform surrounded by lava. Spells
// deal little damage, but every point of damage you take this round (shown
// on the original's mana bar) makes the next hit throw you further, so the
// lava, not the spells, is what kills. The platform loses a tile every
// 15·√alive seconds. Last warlock standing wins the round; kills, assists and
// round wins are worth a point each. Between rounds everyone gets gold for
// the shop.
//
// The simulation runs in the WC3 engine's 0.03 s steps. Movement, casting and
// knockback follow what was measured in the real game (docs/wc3-observations.md);
// the rules and numbers follow Warlock v1.02 (see shared/warlockData.js).

import { SPELLS, ITEMS, WARLOCK, UNIT, MAX_ITEMS, stat, itemStat, upgradeCost } from '../shared/warlockData.js';
import {
  Unit, newId, stepUnits, collideUnits, dist, clamp, rand, pick, round1, round2, unitSnap, wrapAngle,
} from '../engine/server/sim.js';

const SELF_CAST = new Set(['shield', 'rush', 'windwalk', 'scourge']);
const SOLID_PROJECTILES = new Set(['fireball', 'homing', 'bouncer', 'boomerang', 'drain', 'link', 'swap']);
const KILL_CREDIT_WINDOW = 8;
const MAX_EXTRA_ROUNDS = 3;
const FAST_FORWARD = 5; // game speed once only bots are left fighting

export class WarlockGame {
  constructor(room, settings) {
    this.room = room;
    this.mode = 'warlock';
    this.rounds = settings.rounds || 11;
    this.rocks = !!settings.rocks; // obstacles on the arena: a lobby option, off by default
    this.round = 0;
    this.time = 0;
    this.events = [];
    this.projectiles = [];
    this.meteors = [];
    this.links = [];
    this.obstacles = [];
    this.over = false;
    this.ps = new Map();
    for (const p of room.playerList()) {
      this.ps.set(p.id, {
        id: p.id,
        gold: WARLOCK.startGold,
        score: 0,
        wins: 0,
        kills: 0,
        assists: 0,
        deaths: 0,
        dmg: 0,
        roundDmg: 0,
        // Everyone starts with the two basics: Fireball and Scourge, the
        // close-range blast that hurts the caster too.
        spells: { fireball: 1, scourge: 1 },
        slots: ['fireball', null, null, null, null, null, null, 'scourge'],
        invested: {},
        items: {},
        cds: {},
        ready: false,
        unit: null,
        lastAttacker: null,
        lastHitAt: -99,
        hitBy: new Map(), // attacker id -> time of their last hit this round (assists)
        bot: p.bot ? { think: 0, castLock: 0, strafe: Math.random() < 0.5 ? 1 : -1, shopAt: 0, style: pick(['aggro', 'mobile', 'control']) } : null,
      });
    }
    this.tiles = WARLOCK.baseTiles + Math.floor(Math.sqrt(this.ps.size));
    this.baseArena = this.tiles * WARLOCK.tile;
    this.arenaR = this.baseArena;
    this.lavaT = 0;
    this.mapInfo = { v: 1, theme: 'lava', floor: { shape: 'disc', r: this.baseArena }, bounds: this.baseArena + 8 };
    this.enterShop();
  }

  // ---------------------------------------------------------------- phases

  enterShop() {
    this.phase = 'shop';
    this.timer = this.round === 0 ? WARLOCK.firstShopTime : WARLOCK.shopTime;
    this.projectiles = [];
    this.meteors = [];
    this.links = [];
    for (const s of this.ps.values()) {
      s.ready = false;
      if (s.bot) s.bot.shopAt = rand(1.5, 6);
    }
    this.spawnWarlocks(true);
    this.msg(this.round === 0 ? 'SHOPTIME! Buy spells and items — the first round starts soon.' : 'SHOPTIME!');
  }

  startRound() {
    this.round++;
    this.phase = 'play';
    this.roundTime = 0;
    this.shrinkT = 0;
    this.fastForward = false;
    this.lavaT = 0;
    this.arenaR = this.baseArena;
    this.projectiles = [];
    this.meteors = [];
    this.links = [];
    for (const s of this.ps.values()) {
      s.roundDmg = 0;
      s.cds = {};
      s.hitBy.clear();
    }
    this.spawnWarlocks(false);
    this.placeObstacles();
    this.timer = 0;
    this.ev({ k: 'sfx', s: 'start' });
    this.msg(`Round ${this.round}${this.round > this.rounds ? ' (tie-breaker)' : ` of ${this.rounds}`} — FIGHT!`);
  }

  endRound() {
    this.phase = 'roundEnd';
    this.timer = 3.5;
    const alive = [...this.ps.values()].filter((s) => s.unit && s.unit.alive);
    if (alive.length === 1) {
      const w = alive[0];
      w.score++;
      w.wins++;
      this.msg(`${this.name(w.id)} wins round ${this.round}! (+1 point)`, this.room.colorOf(w.id));
      this.ev({ k: 'sfx', s: 'win' });
    } else {
      this.msg(`Round ${this.round} is a draw!`);
    }
    const top = [...this.ps.values()].sort((a, b) => b.roundDmg - a.roundDmg)[0];
    if (top && top.roundDmg > 0) this.msg(`Damage leader: ${this.name(top.id)} (${top.roundDmg.toFixed(1)})`, this.room.colorOf(top.id));
    for (const s of this.ps.values()) s.gold += WARLOCK.goldPerRound;
  }

  spawnWarlocks(preview) {
    // As in the map: evenly around a circle of 768 + 64·n units from a random
    // start angle, everyone facing the centre.
    const list = [...this.ps.values()];
    const R = Math.min(this.baseArena - 2 * WARLOCK.tile, WARLOCK.spawnBase + WARLOCK.spawnPerPlayer * list.length);
    const off = Math.random() * Math.PI * 2;
    this.spawnPoints = [];
    list.forEach((s, i) => {
      const a = off + (i / list.length) * Math.PI * 2;
      const x = Math.cos(a) * R;
      const y = Math.sin(a) * R;
      this.spawnPoints.push([x, y]);
      const u = new Unit({ kind: 'warlock', owner: s.id, x, y, r: WARLOCK.radius, hp: this.maxHpOf(s) });
      u.setFacing(a + Math.PI);
      u.kbPoints = 0;
      u.casting = null;
      u.queued = null;
      u.buffs = { shield: 0, invis: 0, dash: null, absorb: 0, absorbT: 0, slow: 0, invuln: 0 };
      this.applyStats(s, u);
      if (preview) u.stun = 999;
      s.unit = u;
      s.lastAttacker = null;
    });
  }

  placeObstacles() {
    this.obstacles = [];
    if (!this.rocks) return;
    const n = Math.floor(rand(2, 9));
    for (let tries = 0; tries < 200 && this.obstacles.length < n; tries++) {
      const a = rand(0, Math.PI * 2);
      const r = Math.sqrt(Math.random()) * (this.baseArena - 4);
      const o = { id: newId(), x: Math.cos(a) * r, y: Math.sin(a) * r, r: rand(0.8, 1.6) };
      if (this.spawnPoints.some(([x, y]) => dist(x, y, o.x, o.y) < 4)) continue;
      if (this.obstacles.some((q) => dist(q.x, q.y, o.x, o.y) < q.r + o.r + 2)) continue;
      this.obstacles.push(o);
    }
  }

  maxHpOf(s) {
    return WARLOCK.hp + itemStat(s.items, 'hp');
  }

  applyStats(s, u) {
    u.maxHp = this.maxHpOf(s);
    u.speed = WARLOCK.speed + itemStat(s.items, 'speed');
    u.kbResist = 1 - itemStat(s.items, 'kb');
    u.regen = WARLOCK.regen + itemStat(s.items, 'regen');
    u.debuff = Math.max(0.2, 1 + itemStat(s.items, 'debuff'));
    this.updateSpeed(u);
  }

  // WC3 speed modifiers are flat: Drain takes 50 off, Windwalk adds 200.
  // Everything the owner's client needs to run its own warlock's movement
  // forward from this snapshot (client-side prediction): the exact position,
  // heading, orders, knockback, speed and casting stage.
  predictState(s) {
    const u = s.unit;
    if (!u?.alive || this.phase !== 'play') return null;
    const r4 = (v) => Math.round(v * 1e4) / 1e4;
    const c = u.casting;
    const q = u.queued;
    return {
      sq: s.seq ?? -1,
      x: r4(u.x), y: r4(u.y), h: r4(u.heading), f: r4(u.facing), ds: u.dispStep,
      t: u.target ? [r4(u.target.x), r4(u.target.y)] : null,
      v: [r4(u.vx), r4(u.vy)],
      sp: r4(u.speed * u.speedMult), tr: u.turnRate, pw: u.propWindow,
      cp: this.room.tuning?.castPoint ?? WARLOCK.castPoint,
      st: u.stun > 0 ? r4(u.stun) : 0,
      c: c ? { id: c.id, x: c.tx, y: c.ty, l: r4(c.lock), g: c.charge == null ? null : r4(c.charge) } : null,
      q: q ? (q.c === 'cast' ? { c: 'cast', id: q.id, x: q.tx, y: q.ty } : { ...q }) : null,
      d: u.buffs.dash ? [r4(u.buffs.dash.vx), r4(u.buffs.dash.vy), r4(u.buffs.dash.t)] : null,
      cd: Object.fromEntries(Object.entries(s.cds).filter(([, v]) => v > 0).map(([k, v]) => [k, r4(v)])),
    };
  }

  updateSpeed(u) {
    let delta = 0;
    if (u.buffs.slow > 0) delta -= SPELLS.drain.slow;
    if (u.buffs.invis > 0) delta += u.buffs.invisBonus;
    u.speedMult = Math.max(0.2, (u.speed + delta) / u.speed);
  }

  // --------------------------------------------------------------- commands

  command(pid, m) {
    const s = this.ps.get(pid);
    if (!s) return;
    const u = s.unit;
    // Orders carry a sequence number; the owner's snapshot echoes the last
    // one handled so the client can replay the rest on its prediction.
    if (Number.isFinite(m.q) && (m.c === 'move' || m.c === 'stop' || m.c === 'cast')) s.seq = m.q;
    switch (m.c) {
      case 'move':
      case 'stop': {
        if (this.phase !== 'play' || !u?.alive) break;
        const order = m.c === 'move' ? { c: 'move', x: +m.x || 0, y: +m.y || 0 } : { c: 'stop' };
        // Measured in WC3: an order given during the cast point waits for it
        // to end instead of cancelling the spell. Before the cast has begun
        // (while still turning), a new order replaces the spell.
        if (u.casting?.lock || u.casting?.charge > 0 || u.buffs.dash) u.queued = order;
        else {
          u.casting = null;
          this.doOrder(u, order);
        }
        break;
      }
      case 'cast':
        if (this.phase === 'play') this.cast(s, m.spell, +m.x || 0, +m.y || 0);
        break;
      case 'buy':
        this.buy(s, m.id);
        break;
      case 'sell':
        this.sell(s, m.id);
        break;
      case 'ready':
        if (this.phase === 'shop') s.ready = !s.ready;
        break;
    }
  }

  buy(s, id) {
    if (this.phase !== 'shop') return false;
    const spell = SPELLS[id];
    const item = ITEMS[id];
    if (spell) {
      const lvl = s.spells[id] || 0;
      if (lvl >= spell.maxLevel) return false;
      const cost = upgradeCost(spell, lvl);
      if (s.gold < cost) return false;
      // One spell per column: buying another replaces it (half refund).
      const current = s.slots[spell.slot];
      if (lvl === 0 && current && current !== id) this.sell(s, current);
      s.gold -= cost;
      s.spells[id] = lvl + 1;
      s.invested[id] = (s.invested[id] || 0) + cost;
      s.slots[spell.slot] = id;
    } else if (item) {
      const lvl = s.items[id] || 0;
      if (lvl >= item.maxLevel) return false;
      if (lvl === 0 && Object.keys(s.items).length >= MAX_ITEMS) return false;
      if (s.gold < item.cost) return false;
      s.gold -= item.cost;
      s.items[id] = lvl + 1;
      if (s.unit) {
        this.applyStats(s, s.unit);
        s.unit.hp = s.unit.maxHp;
      }
    } else return false;
    this.ev({ k: 'sfx', s: 'buy', to: s.id });
    return true;
  }

  sell(s, id) {
    if (this.phase !== 'shop') return;
    if (id === 'scourge' && s.invested.scourge) {
      // A starting spell: selling refunds the upgrades and leaves level 1.
      s.gold += Math.floor(s.invested.scourge / 2);
      delete s.invested.scourge;
      s.spells.scourge = 1;
    } else if (SPELLS[id] && id !== 'fireball' && id !== 'scourge' && s.spells[id]) {
      s.gold += Math.floor((s.invested[id] || 0) / 2);
      delete s.spells[id];
      delete s.invested[id];
      s.slots[SPELLS[id].slot] = null;
    } else if (ITEMS[id] && s.items[id]) {
      s.gold += Math.floor((ITEMS[id].cost * s.items[id]) / 2);
      delete s.items[id];
      if (s.unit) this.applyStats(s, s.unit);
    }
  }

  doOrder(u, o) {
    if (o.c === 'move') u.order(o.x, o.y);
    else u.stop();
  }

  // Casting, as measured in WC3 (Warlock 0.99, the warlock's 0.3 s cast point):
  //  1. The caster stops and turns toward the target at its turn rate, with
  //     no propulsion window: the cast begins only on the step after the
  //     heading is exactly on target (at once if already facing it).
  //  2. "Begins casting": the map launches the spell right here.
  //  3. Then the 0.3 s cast point, during which the warlock is locked. Orders
  //     given now wait for it to end. Cooldown starts when it ends.
  cast(s, id, tx, ty) {
    const u = s.unit;
    const def = SPELLS[id];
    const lvl = s.spells[id];
    if (!def || !lvl || !u?.alive || u.stun > 0) return;
    if (id === 'shield') return; // autocast only: see autoShield()
    if (u.casting?.lock || u.casting?.charge > 0 || u.buffs.dash) {
      u.queued = { c: 'cast', id, tx, ty };
      return;
    }
    if ((s.cds[id] || 0) > 0) return this.notReady(s);
    u.target = null;
    u.queued = null;
    u.casting = { id, tx, ty, lock: 0 };
    if (SELF_CAST.has(id) || Math.abs(wrapAngle(Math.atan2(ty - u.y, tx - u.x) - u.heading)) < 1e-3) this.beginCast(s);
  }

  // Shield is an autocast: when it is learned and ready, it goes up by
  // itself (no cast point, nothing interrupted) as a hostile projectile on a
  // collision course is about to reach the shield's edge.
  autoShield(s, p) {
    const u = s.unit;
    const lvl = s.spells.shield;
    if (!lvl || !u?.alive || u.buffs.shield > 0 || (s.cds.shield || 0) > 0) return;
    const rx = u.x - p.x;
    const ry = u.y - p.y;
    const sp = Math.hypot(p.vx, p.vy) || 1;
    const along = (rx * p.vx + ry * p.vy) / sp; // distance to the closest approach
    if (along <= 0) return;
    const miss = Math.abs(rx * p.vy - ry * p.vx) / sp;
    if (miss > u.r + p.r + 0.3) return;
    const def = SPELLS.shield;
    const R = stat(def, 'aoe', lvl);
    if (Math.hypot(rx, ry) > R + sp * 0.12) return; // about 4 steps out
    u.buffs.shield = stat(def, 'duration', lvl);
    u.buffs.shieldR = R;
    s.cds.shield = stat(def, 'cd', lvl);
    this.ev({ k: 'cast', s: 'shield', x: round1(u.x), y: round1(u.y), u: u.id });
  }

  notReady(s) {
    this.ev({ k: 'err', text: 'Spell is not ready yet.', to: s.id });
  }

  // One 0.03 s step of the cast sequence.
  stepCast(s, dt) {
    const u = s.unit;
    const c = u.casting;
    if (c.charge > 0) {
      c.charge -= dt;
      if (c.charge <= 1e-6) {
        c.charge = 0;
        this.beginCast(s);
      }
      return;
    }
    if (c.lock > 0) {
      c.lock -= dt;
      if (c.lock <= 1e-6) {
        u.casting = null;
        const lvl = s.spells[c.id];
        if (lvl) s.cds[c.id] = stat(SPELLS[c.id], 'cd', lvl);
        const q = u.queued;
        u.queued = null;
        if (q?.c === 'cast') this.cast(s, q.id, q.tx, q.ty);
        else if (q) this.doOrder(u, q);
      }
      return;
    }
    const want = Math.atan2(c.ty - u.y, c.tx - u.x);
    if (Math.abs(wrapAngle(want - u.heading)) < 1e-3) this.beginCast(s);
    else u.turnStep(want, dt);
  }

  beginCast(s) {
    const u = s.unit;
    const c = u.casting;
    if ((s.cds[c.id] || 0) > 0) {
      u.casting = null;
      return this.notReady(s);
    }
    // Spells with a cast time (Scourge) wind up first. As in the map, the
    // wind-up can't be stopped: the caster can't walk (momentum and
    // knockback still carry it), and orders given meanwhile wait for it.
    const castTime = SPELLS[c.id].castTime;
    if (castTime && c.charge == null) {
      c.charge = castTime;
      u.target = null;
      this.ev({ k: 'charge', s: c.id, u: u.id, t: castTime });
      return;
    }
    c.lock = this.room.tuning?.castPoint ?? WARLOCK.castPoint;
    this.execCast(s, c.id, c.tx, c.ty);
    if (c.lock <= 0) {
      c.lock = 1e-9;
      this.stepCast(s, 0);
    }
  }

  execCast(s, id, tx, ty) {
    const u = s.unit;
    const def = SPELLS[id];
    const lvl = s.spells[id];
    if (!def || !lvl || !u?.alive) return;
    // Blocks re-casting until the cooldown proper starts after the cast point.
    s.cds[id] = stat(def, 'cd', lvl);
    if (id !== 'windwalk' && u.buffs.invis > 0) this.endWindwalk(u);
    let dx = tx - u.x;
    let dy = ty - u.y;
    const d = Math.hypot(dx, dy) || 0.001;
    dx /= d;
    dy /= d;
    const spawn = (extra = {}) => {
      const speed = stat(def, 'speed', lvl);
      const range = extra.range ?? stat(def, 'range', lvl);
      const life = def.life ? stat(def, 'life', lvl) : range / speed;
      const p = {
        id: newId(), kind: id, owner: s.id, level: lvl,
        // The map creates projectiles at the caster's centre.
        x: u.x, y: u.y,
        vx: dx * speed, vy: dy * speed, speed,
        r: stat(def, 'radius', lvl), life, age: 0, hit: new Set(), ...extra,
      };
      this.projectiles.push(p);
      return p;
    };
    this.ev({ k: 'cast', s: id, x: round1(u.x), y: round1(u.y), u: u.id });

    switch (id) {
      case 'fireball':
      case 'homing':
      case 'drain':
      case 'link':
      case 'gravity':
        spawn();
        break;
      case 'swap':
        spawn({ range: Math.min(d, stat(def, 'range', lvl)) });
        break;
      case 'bouncer':
        spawn({ bounces: stat(def, 'bounces', lvl) });
        break;
      case 'boomerang': {
        const range = Math.min(Math.max(d, 4), stat(def, 'range', lvl));
        spawn({ out: true, outTime: range / stat(def, 'speed', lvl), life: 6 });
        break;
      }
      case 'scourge': {
        const aoe = def.aoe;
        const dmg = stat(def, 'dmg', lvl);
        for (const o of this.ps.values()) {
          const v = o.unit;
          if (!v?.alive || o === s) continue;
          const dd = dist(u.x, u.y, v.x, v.y);
          if (dd > aoe + v.r) continue;
          // Full knockback (more with upgrades): a close-range heavy hitter.
          this.damage(o, dmg, s, v.x - u.x || 0.01, v.y - u.y, stat(def, 'kbPct', lvl) / 100);
        }
        u.hp = Math.max(1, u.hp - def.selfDmg); // the same cost at every level
        this.ev({ k: 'boom', x: round1(u.x), y: round1(u.y), r: aoe, c: def.color, big: 1 });
        break;
      }
      case 'lightning': {
        const range = stat(def, 'range', lvl);
        let best = null;
        let bestT = range;
        const test = (x, y, r, obj) => {
          const rx = x - u.x;
          const ry = y - u.y;
          const t = rx * dx + ry * dy;
          if (t < 0 || t > bestT) return;
          if (Math.abs(rx * dy - ry * dx) < r + 0.5) {
            best = obj;
            bestT = t;
          }
        };
        for (const o of this.ps.values()) if (o.unit?.alive && o !== s) test(o.unit.x, o.unit.y, o.unit.r, { pawn: o });
        for (const p of this.projectiles) if (p.kind === 'fireball') test(p.x, p.y, p.r, { fireball: p });
        for (const ob of this.obstacles) test(ob.x, ob.y, ob.r, { obstacle: ob });
        const ex = u.x + dx * bestT;
        const ey = u.y + dy * bestT;
        this.ev({ k: 'bolt', x1: round1(u.x), y1: round1(u.y), x2: round1(ex), y2: round1(ey) });
        if (best?.pawn) this.damage(best.pawn, stat(def, 'dmg', lvl), s, dx, dy, def.kbf);
        else if (best?.fireball) {
          // Fireball + Lightning combo: detonate the fireball.
          const fb = best.fireball;
          fb.dead = true;
          const area = 225 / 50;
          const dmgMax = (2 / 3) * (stat(def, 'dmg', lvl) + 7);
          this.areaDamage(fb.x, fb.y, area, dmgMax, dmgMax * 0.5, s, 1.35, null);
          this.ev({ k: 'boom', x: round1(fb.x), y: round1(fb.y), r: area, c: '#ffcf6a', big: 1 });
        }
        break;
      }
      case 'meteor': {
        const md = Math.min(d, stat(def, 'range', lvl));
        this.meteors.push({
          id: newId(), owner: s.id, level: lvl, x: u.x + dx * md, y: u.y + dy * md,
          t: def.delay, delay: def.delay, aoe: stat(def, 'aoe', lvl),
        });
        break;
      }
      case 'teleport': {
        const md = Math.min(d, stat(def, 'range', lvl));
        const x0 = u.x;
        const y0 = u.y;
        u.x += dx * md;
        u.y += dy * md;
        u.target = null;
        u.vx *= def.kbCut;
        u.vy *= def.kbCut;
        this.ev({ k: 'tele', x1: round1(x0), y1: round1(y0), x2: round1(u.x), y2: round1(u.y) });
        break;
      }
      case 'thrust': {
        const range = Math.min(d, stat(def, 'range', lvl));
        u.buffs.dash = { vx: dx * def.dashSpeed, vy: dy * def.dashSpeed, t: range / def.dashSpeed, lvl };
        u.target = null;
        break;
      }
      case 'shield':
        u.buffs.shield = stat(def, 'duration', lvl);
        u.buffs.shieldR = stat(def, 'aoe', lvl);
        break;
      case 'rush':
        u.buffs.absorb = stat(def, 'absorb', lvl);
        u.buffs.absorbT = stat(def, 'duration', lvl);
        break;
      case 'windwalk':
        u.buffs.invis = def.duration;
        u.buffs.invisBonus = def.speedBonus;
        u.buffs.wwDmg = stat(def, 'dmg', lvl);
        this.updateSpeed(u);
        break;
    }
  }

  endWindwalk(u) {
    u.buffs.invis = 0;
    this.updateSpeed(u);
  }

  // Deals damage the Warlock way (measured in the 0.99 engine log): the
  // damage is first added to the victim's damage taken M (kbPoints), then the
  // hit adds a knockback velocity of D·(100 + M) units per second away from
  // the source. With 0.96 friction per 0.03 s step the slide is
  // 0.72·D·(100 + M) units.
  damage(target, amount, src, nx = 0, ny = 0, kbFactor = 1, kbVuln = 1) {
    const u = target.unit;
    // Once the round is decided, spells still in the air do no harm.
    if (!u?.alive || amount <= 0 || this.phase !== 'play') return;
    if (u.buffs.invuln > 0) return;
    if (u.buffs.absorb > 0) {
      const a = Math.min(u.buffs.absorb, amount);
      u.buffs.absorb -= a;
      amount -= a;
      if (amount <= 0) {
        this.ev({ k: 'reflect', x: round1(u.x), y: round1(u.y) });
        return;
      }
    }
    u.hp -= amount;
    u.kbPoints += amount * kbVuln;
    if (src && src.id !== target.id) {
      target.lastAttacker = src.id;
      target.lastHitAt = this.time;
      target.hitBy.set(src.id, this.time);
      src.dmg += amount;
      src.roundDmg += amount;
    }
    if (kbFactor > 0 && (nx || ny)) {
      const v = kbFactor * amount * (WARLOCK.kbBase + u.kbPoints) * UNIT;
      u.knock(nx, ny, v);
    }
    if (kbVuln === 1) this.ev({ k: 'dmg', x: round1(u.x), y: round1(u.y), n: round1(amount) });
  }

  areaDamage(x, y, r, dmgMax, dmgMin, src, kbFactor, exclude) {
    for (const o of this.ps.values()) {
      const u = o.unit;
      if (!u?.alive || o === exclude) continue;
      const d = dist(x, y, u.x, u.y);
      if (d > r + u.r) continue;
      const k = clamp(d / r, 0, 1);
      this.damage(o, dmgMax + (dmgMin - dmgMax) * k, o === src ? null : src, u.x - x || 0.01, u.y - y, kbFactor);
    }
  }

  // ------------------------------------------------------------------- tick

  tick(dt) {
    this.time += dt;
    if (this.phase === 'shop') {
      this.timer -= dt;
      for (const s of this.ps.values()) if (s.bot) this.botShop(s, dt);
      const humans = [...this.ps.values()].filter((s) => !this.room.isBot(s.id) && this.room.isConnected(s.id));
      if (this.timer <= 3 && Math.ceil(this.timer) !== Math.ceil(this.timer + dt)) this.ev({ k: 'sfx', s: 'beep' });
      if (this.timer <= 0) this.startRound();
      else if (humans.length > 0 && humans.every((s) => s.ready) && this.timer > 3) this.timer = 3;
      return;
    }
    if (this.phase === 'roundEnd') {
      this.timer -= dt;
      this.stepWorld(dt, false);
      if (this.timer <= 0) {
        if (this.gameDecided()) this.finish();
        else this.enterShop();
      }
      return;
    }
    if (this.phase === 'over') return;

    // Once only bots are left fighting, play on at FAST_FORWARD speed.
    if (!this.fastForward && this.ps.size > 1) {
      const alive = [...this.ps.values()].filter((s) => s.unit?.alive);
      if (alive.length > 1 && alive.every((s) => this.room.isBot(s.id))) {
        this.fastForward = true;
        this.msg(`Only bots are left: fast-forward ×${FAST_FORWARD}.`);
      }
    }
    const steps = this.fastForward ? FAST_FORWARD : 1;
    for (let i = 0; i < steps && this.phase === 'play'; i++) {
      if (i) this.time += dt;
      this.stepPlay(dt);
    }
  }

  stepPlay(dt) {
    this.roundTime += dt;
    this.timer = this.roundTime;
    // The platform loses a whole tile every 15·√alive seconds until nothing
    // is left, so every round is guaranteed to end. WC3 re-lays terrain
    // tiles instantly, so the edge jumps rather than shrinking smoothly.
    const aliveNow = [...this.ps.values()].filter((s) => s.unit?.alive).length;
    this.shrinkT += dt;
    if (this.shrinkT >= WARLOCK.shrinkPeriod * Math.sqrt(Math.max(1, aliveNow)) && this.arenaR > 0) {
      this.shrinkT = 0;
      this.arenaR = Math.max(0, this.arenaR - WARLOCK.tile);
    }

    for (const s of this.ps.values()) {
      const casting = s.unit?.casting;
      for (const k in s.cds) {
        // The cooldown only starts once the cast point is over.
        if (casting?.lock > 0 && casting.id === k) continue;
        s.cds[k] = Math.max(0, s.cds[k] - dt);
      }
      if (s.bot && s.unit?.alive) this.botThink(s, dt);
    }
    this.stepWorld(dt, true);

    const alive = [...this.ps.values()].filter((s) => s.unit?.alive);
    if (alive.length <= 1 && this.ps.size > 1) this.endRound();
    else if (alive.length === 0) this.endRound();
  }

  gameDecided() {
    if (this.round < this.rounds) return false;
    const scores = [...this.ps.values()].map((s) => s.score).sort((a, b) => b - a);
    const tied = scores.length > 1 && scores[0] === scores[1];
    return !tied || this.round >= this.rounds + MAX_EXTRA_ROUNDS;
  }

  stepWorld(dt, lava) {
    const units = [...this.ps.values()].map((s) => s.unit).filter(Boolean);

    for (const s of this.ps.values()) {
      const u = s.unit;
      if (!u?.alive) continue;
      const b = u.buffs;
      if (u.casting) this.stepCast(s, dt);
      if (b.invuln > 0) b.invuln -= dt;
      if (b.shield > 0) b.shield -= dt;
      if (b.absorbT > 0) {
        b.absorbT -= dt;
        if (b.absorbT <= 0) b.absorb = 0;
      }
      if (b.slow > 0) {
        b.slow -= dt;
        if (b.slow <= 0) this.updateSpeed(u);
      }
      if (b.invis > 0) {
        b.invis -= dt;
        if (b.invis <= 0) this.endWindwalk(u);
        else {
          // Running into someone while windwalking deals damage.
          for (const o of this.ps.values()) {
            const v = o.unit;
            if (!v?.alive || v === u) continue;
            if (dist(u.x, u.y, v.x, v.y) < u.r + v.r + 0.15) {
              this.damage(o, b.wwDmg, s, v.x - u.x || 0.01, v.y - u.y);
              this.ev({ k: 'boom', x: round1(v.x), y: round1(v.y), r: 1, c: SPELLS.windwalk.color });
              this.endWindwalk(u);
              break;
            }
          }
        }
      }
      if (b.dash) {
        u.x += b.dash.vx * dt;
        u.y += b.dash.vy * dt;
        u.setFacing(Math.atan2(b.dash.vy, b.dash.vx));
        b.dash.t -= dt;
        for (const o of this.ps.values()) {
          const v = o.unit;
          if (!v?.alive || v === u) continue;
          if (dist(u.x, u.y, v.x, v.y) < u.r + v.r + SPELLS.thrust.radius * 0.5) {
            this.damage(o, stat(SPELLS.thrust, 'dmg', b.dash.lvl), s, b.dash.vx, b.dash.vy);
            this.ev({ k: 'boom', x: round1(v.x), y: round1(v.y), r: 1.2, c: SPELLS.thrust.color });
            b.dash.t = 0;
            break;
          }
        }
        if (b.dash.t <= 0) {
          b.dash = null;
          const q = u.queued;
          u.queued = null;
          if (q?.c === 'cast') this.cast(s, q.id, q.tx, q.ty);
          else if (q) this.doOrder(u, q);
        }
      }
      if (u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + u.regen * dt);
    }

    // Links drag the target toward the caster.
    for (const l of this.links) {
      l.t -= dt;
      const a = this.ps.get(l.a)?.unit;
      const b = this.ps.get(l.b)?.unit;
      if (!a?.alive || !b?.alive || l.t <= 0) {
        l.dead = true;
        continue;
      }
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.hypot(dx, dy);
      if (d > 1.5) {
        b.vx += (dx / d) * l.pull * dt * 0.8;
        b.vy += (dy / d) * l.pull * dt * 0.8;
        a.vx -= (dx / d) * l.pull * dt * 0.2;
        a.vy -= (dy / d) * l.pull * dt * 0.2;
      }
    }
    this.links = this.links.filter((l) => !l.dead);

    stepUnits(units, dt, { friction: WARLOCK.friction, controlLoss: false });
    // Warlocks that run into each other swap knockback velocities, unless
    // they are linked together.
    const linked = (a, b) => this.links.some((l) => {
      const ua = this.ps.get(l.a)?.unit;
      const ub = this.ps.get(l.b)?.unit;
      return (ua === a && ub === b) || (ua === b && ub === a);
    });
    collideUnits(units, { swap: true, skip: linked });
    for (const u of units) {
      if (!u.alive) continue;
      for (const o of this.obstacles) {
        const d = dist(u.x, u.y, o.x, o.y);
        if (d < u.r + o.r) {
          const nx = (u.x - o.x) / (d || 1);
          const ny = (u.y - o.y) / (d || 1);
          u.x = o.x + nx * (u.r + o.r);
          u.y = o.y + ny * (u.r + o.r);
          // Bounce knockback off the rock.
          const vn = u.vx * nx + u.vy * ny;
          if (vn < 0) {
            u.vx -= 1.6 * vn * nx;
            u.vy -= 1.6 * vn * ny;
          }
        }
      }
    }
    this.stepProjectiles(dt);
    this.stepMeteors(dt);

    // Lava: the map tests the tile under each warlock every 0.1 s, so a
    // warlock walking in takes its first burn a moment after crossing the
    // edge. It adds half its damage to the damage taken.
    this.lavaT += dt;
    const lavaTick = lava && this.lavaT >= WARLOCK.lavaTick - 1e-6;
    if (lavaTick) this.lavaT -= WARLOCK.lavaTick;
    for (const s of this.ps.values()) {
      const u = s.unit;
      if (!u?.alive) continue;
      if (lavaTick || !lava) u.flags.burn = Math.hypot(u.x, u.y) > this.arenaR;
      if (lavaTick && u.flags.burn && !(u.buffs.invuln > 0)) {
        const amt = WARLOCK.lavaDps * WARLOCK.lavaTick;
        u.hp -= amt;
        u.kbPoints += amt * WARLOCK.lavaKbFactor;
      }
      if (u.hp <= 0) this.kill(s);
    }
  }

  kill(s) {
    const u = s.unit;
    u.alive = false;
    u.hp = 0;
    s.deaths++;
    this.ev({ k: 'death', x: round1(u.x), y: round1(u.y), u: u.id });
    let killer = null;
    if (s.lastAttacker != null && this.time - s.lastHitAt < KILL_CREDIT_WINDOW) killer = this.ps.get(s.lastAttacker);
    if (killer && killer !== s) {
      // A kill and each assist (anyone else who hit the victim recently) are
      // worth a point.
      killer.kills++;
      killer.score++;
      this.msg(`${this.name(killer.id)} killed ${this.name(s.id)}!`, this.room.colorOf(killer.id));
      for (const [aid, t] of s.hitBy) {
        const a = this.ps.get(aid);
        if (!a || a === killer || this.time - t >= KILL_CREDIT_WINDOW) continue;
        a.assists++;
        a.score++;
      }
    } else {
      this.msg(`${this.name(s.id)} was consumed by the lava.`, this.room.colorOf(s.id));
    }
    this.links = this.links.filter((l) => l.a !== s.id && l.b !== s.id);
  }

  stepProjectiles(dt) {
    const warlocks = [...this.ps.values()].filter((s) => s.unit?.alive);
    const gravities = this.projectiles.filter((p) => p.kind === 'gravity' && !p.dead);
    for (const p of this.projectiles) {
      if (p.dead) continue;
      p.age += dt;
      p.life -= dt;
      const def = SPELLS[p.kind];
      const owner = this.ps.get(p.owner);

      if (p.kind === 'homing') {
        let best = null;
        let bd = 30;
        for (const s of warlocks) {
          if (s.id === p.owner || s.unit.buffs.invis > 0) continue;
          const d = dist(p.x, p.y, s.unit.x, s.unit.y);
          if (d < bd) {
            bd = d;
            best = s.unit;
          }
        }
        if (best) {
          const want = Math.atan2(best.y - p.y, best.x - p.x);
          let cur = Math.atan2(p.vy, p.vx);
          const diff = ((want - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          cur += clamp(diff, -def.turn * dt, def.turn * dt);
          p.vx = Math.cos(cur) * p.speed;
          p.vy = Math.sin(cur) * p.speed;
        }
      } else if (p.kind === 'boomerang') {
        if (p.out && p.age >= p.outTime) {
          p.out = false;
          p.hit.clear();
        }
        if (!p.out) {
          const home = owner?.unit;
          if (!home?.alive) p.life = 0;
          else {
            const dx = home.x - p.x;
            const dy = home.y - p.y;
            const d = Math.hypot(dx, dy) || 1;
            if (d < home.r + 0.4) p.life = 0;
            const sp = Math.min(p.speed, p.speed * (0.3 + (p.age - p.outTime) * 1.5));
            p.vx += ((dx / d) * sp - p.vx) * Math.min(1, dt * 6);
            p.vy += ((dy / d) * sp - p.vy) * Math.min(1, dt * 6);
          }
        } else {
          const c = Math.cos(dt * 0.9);
          const sn = Math.sin(dt * 0.9);
          [p.vx, p.vy] = [p.vx * c - p.vy * sn, p.vx * sn + p.vy * c];
        }
      } else if (p.kind === 'gravity') {
        const pull = stat(def, 'pull', p.level);
        const dps = stat(def, 'dmg', p.level) / (stat(def, 'range', p.level) / stat(def, 'speed', p.level));
        for (const s of warlocks) {
          const u = s.unit;
          const dx = p.x - u.x;
          const dy = p.y - u.y;
          const d = Math.hypot(dx, dy);
          if (d < def.pullRadius && d > 0.3) {
            const f = pull * (1 - d / def.pullRadius) * dt * 2;
            u.vx += (dx / d) * f;
            u.vy += (dy / d) * f;
          }
          if (d < def.dmgRadius && s.id !== p.owner) this.damage(s, dps * dt, owner, 0, 0, 0);
        }
      }

      // Gravity wells bend nearby projectiles too.
      if (p.kind !== 'gravity') {
        for (const g of gravities) {
          const dx = g.x - p.x;
          const dy = g.y - p.y;
          const d = Math.hypot(dx, dy);
          if (d < 12 && d > 0.3) {
            const f = stat(SPELLS.gravity, 'pull', g.level) * 1.5 * (1 - d / 12) * dt;
            p.vx += (dx / d) * f;
            p.vy += (dy / d) * f;
          }
        }
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.life <= 0) {
        p.dead = true;
        if (p.kind === 'swap') this.swapWithProjectile(p, owner);
        else if (p.kind !== 'boomerang') this.ev({ k: 'fizzle', x: round1(p.x), y: round1(p.y), c: def.color });
        continue;
      }
      // Obstacles stop projectiles.
      if (this.obstacles.some((o) => dist(p.x, p.y, o.x, o.y) < o.r + p.r)) {
        p.dead = true;
        this.ev({ k: 'boom', x: round1(p.x), y: round1(p.y), r: 0.8, c: def.color });
        continue;
      }
      if (p.kind === 'gravity') continue;

      // Shields raise themselves when a projectile is about to hit.
      if (SOLID_PROJECTILES.has(p.kind)) for (const s of warlocks) if (s.id !== p.owner) this.autoShield(s, p);
      // Shields reflect projectiles entering their radius.
      let reflected = false;
      for (const s of warlocks) {
        const u = s.unit;
        if (s.id === p.owner || !(u.buffs.shield > 0)) continue;
        const d = dist(p.x, p.y, u.x, u.y);
        if (d < u.buffs.shieldR) {
          const nx = (p.x - u.x) / (d || 1);
          const ny = (p.y - u.y) / (d || 1);
          const vn = p.vx * nx + p.vy * ny;
          if (vn < 0) {
            p.vx -= 2 * vn * nx;
            p.vy -= 2 * vn * ny;
          }
          p.owner = s.id;
          p.hit.clear();
          p.life = Math.max(p.life, 1.2);
          if (p.kind === 'boomerang') {
            p.out = true;
            p.age = 0;
          }
          this.ev({ k: 'reflect', x: round1(p.x), y: round1(p.y) });
          reflected = true;
          break;
        }
      }
      if (reflected) continue;

      for (const s of warlocks) {
        const u = s.unit;
        if (s.id === p.owner || p.hit.has(s.id)) continue;
        if (dist(p.x, p.y, u.x, u.y) > p.r + u.r) continue;
        this.onProjectileHit(p, s, owner, def);
        break;
      }
      if (p.dead) continue;

      // Opposing projectiles annihilate each other.
      if (SOLID_PROJECTILES.has(p.kind)) {
        for (const q of this.projectiles) {
          if (q === p || q.dead || q.owner === p.owner || !SOLID_PROJECTILES.has(q.kind)) continue;
          if (dist(p.x, p.y, q.x, q.y) < p.r + q.r) {
            p.dead = q.dead = true;
            this.ev({ k: 'boom', x: round1((p.x + q.x) / 2), y: round1((p.y + q.y) / 2), r: 0.9, c: def.color });
            break;
          }
        }
      }
    }
    this.projectiles = this.projectiles.filter((p) => !p.dead);
  }

  swapWithProjectile(p, owner) {
    const ou = owner?.unit;
    if (!ou?.alive) return;
    this.ev({ k: 'tele', x1: round1(ou.x), y1: round1(ou.y), x2: round1(p.x), y2: round1(p.y) });
    ou.x = p.x;
    ou.y = p.y;
    ou.target = null;
  }

  onProjectileHit(p, s, owner, def) {
    const u = s.unit;
    const l = Math.hypot(p.vx, p.vy) || 1;
    const dx = p.vx / l;
    const dy = p.vy / l;
    const dmg = def.dmg ? stat(def, 'dmg', p.level) * (p.dmgMult ?? 1) : 0;
    p.hit.add(s.id);
    switch (p.kind) {
      case 'boomerang':
        this.damage(s, dmg, owner, dx, dy);
        break;
      case 'bouncer': {
        this.damage(s, dmg, owner, dx, dy);
        let next = null;
        let bd = 12;
        for (const o of this.ps.values()) {
          if (!o.unit?.alive || o.id === p.owner || p.hit.has(o.id)) continue;
          const d = dist(u.x, u.y, o.unit.x, o.unit.y);
          if (d < bd) {
            bd = d;
            next = o.unit;
          }
        }
        if (next && p.bounces > 0) {
          p.bounces--;
          p.dmgMult = (p.dmgMult ?? 1) * def.bounceLoss;
          const nx = next.x - p.x;
          const ny = next.y - p.y;
          const nl = Math.hypot(nx, ny) || 1;
          p.vx = (nx / nl) * p.speed;
          p.vy = (ny / nl) * p.speed;
          p.life = 1.6;
        } else p.dead = true;
        break;
      }
      case 'homing':
        this.damage(s, dmg, owner, dx, dy);
        this.areaDamage(p.x, p.y, def.aoe, dmg * 0.4, dmg * 0.15, owner, 1, s);
        p.dead = true;
        break;
      case 'drain': {
        this.damage(s, dmg, owner, dx, dy, 0.4);
        u.buffs.slow = stat(def, 'duration', p.level) * u.debuff;
        this.updateSpeed(u);
        const ou = owner?.unit;
        if (ou?.alive) ou.hp = Math.min(ou.maxHp, ou.hp + dmg);
        p.dead = true;
        break;
      }
      case 'link':
        this.damage(s, dmg, owner, dx, dy, 0.3);
        this.links = this.links.filter((ln) => ln.a !== p.owner);
        this.links.push({ a: p.owner, b: s.id, t: def.duration * u.debuff, pull: def.pull });
        p.dead = true;
        break;
      case 'swap': {
        const ou = owner?.unit;
        if (ou?.alive) {
          this.ev({ k: 'tele', x1: round1(ou.x), y1: round1(ou.y), x2: round1(u.x), y2: round1(u.y) });
          [ou.x, ou.y, u.x, u.y] = [u.x, u.y, ou.x, ou.y];
          ou.target = null;
          u.target = null;
        }
        p.dead = true;
        break;
      }
      default:
        this.damage(s, dmg, owner, dx, dy);
        p.dead = true;
    }
    this.ev({ k: 'boom', x: round1(p.x), y: round1(p.y), r: 0.8, c: def.color });
  }

  stepMeteors(dt) {
    for (const m of this.meteors) {
      m.t -= dt;
      if (m.t > 0) continue;
      m.dead = true;
      const def = SPELLS.meteor;
      const owner = this.ps.get(m.owner);
      this.ev({ k: 'boom', x: round1(m.x), y: round1(m.y), r: m.aoe, c: def.color, big: 1 });
      this.areaDamage(m.x, m.y, m.aoe, stat(def, 'dmg', m.level), stat(def, 'dmgMin', m.level), owner, 1, null);
      // Meteors also smash projectiles in the impact area.
      for (const p of this.projectiles) if (dist(p.x, p.y, m.x, m.y) < m.aoe) p.dead = true;
    }
    this.meteors = this.meteors.filter((m) => !m.dead);
  }

  finish() {
    this.phase = 'over';
    this.over = true;
    const ranked = this.standings();
    this.msg(`${this.name(ranked[0].id)} is the greatest warlock!`, this.room.colorOf(ranked[0].id));
    this.ev({ k: 'sfx', s: 'victory' });
  }

  standings() {
    return [...this.ps.values()]
      .map((s) => ({ id: s.id, score: s.score, wins: s.wins, kills: s.kills, assists: s.assists, dmg: round1(s.dmg) }))
      .sort((a, b) => b.score - a.score || b.dmg - a.dmg);
  }

  // ------------------------------------------------------------------- bots

  botShop(s, dt) {
    const b = s.bot;
    if (s.ready) return;
    b.shopAt -= dt;
    if (b.shopAt > 0) return;
    const prefs = {
      aggro: ['homing', 'thrust', 'bouncer', 'meteor', 'shield', 'link'],
      mobile: ['lightning', 'teleport', 'drain', 'windwalk', 'rush', 'gravity'],
      control: ['boomerang', 'swap', 'bouncer', 'meteor', 'shield', 'gravity'],
    }[b.style];
    for (let tries = 0; tries < 12; tries++) {
      const missing = prefs.filter((id) => !s.slots[SPELLS[id].slot]);
      const r = Math.random();
      let bought = false;
      if (missing.length && r < 0.55) bought = this.buy(s, missing[0]);
      else if (r < 0.75) bought = this.buy(s, pick(s.slots.filter(Boolean)));
      else bought = this.buy(s, pick(['ring', 'armor', 'boots', 'cape', 'ring']));
      if (!bought && s.gold < 4) break;
    }
    s.ready = true;
  }

  botThink(s, dt) {
    const b = s.bot;
    const u = s.unit;
    b.think -= dt;
    b.castLock -= dt;
    if (b.think > 0 || u.buffs.dash || u.casting) return;
    b.think = rand(0.16, 0.3);

    const R = this.arenaR;
    const d0 = Math.hypot(u.x, u.y);
    let target = null;
    let td = Infinity;
    for (const o of this.ps.values()) {
      if (o === s || !o.unit?.alive || o.unit.buffs.invis > 0) continue;
      const d = dist(u.x, u.y, o.unit.x, o.unit.y);
      if (d < td) {
        td = d;
        target = o.unit;
      }
    }
    const ready = (id) => s.spells[id] && !(s.cds[id] > 0);

    // Dodge incoming projectiles.
    for (const p of this.projectiles) {
      if (p.owner === s.id || p.kind === 'gravity') continue;
      const rx = u.x - p.x;
      const ry = u.y - p.y;
      const sp = Math.hypot(p.vx, p.vy) || 1;
      const t = (rx * p.vx + ry * p.vy) / (sp * sp);
      if (t < 0 || t > 1) continue;
      const cx = p.x + p.vx * t - u.x;
      const cy = p.y + p.vy * t - u.y;
      if (Math.hypot(cx, cy) > u.r + p.r + 0.7) continue;
      if (t < 0.45 && ready('rush') && Math.random() < 0.4) return this.cast(s, 'rush', u.x, u.y);
      let px = -p.vy / sp;
      let py = p.vx / sp;
      if (px * -u.x + py * -u.y < 0) [px, py] = [-px, -py];
      if (Math.random() < 0.75) {
        u.order(u.x + px * 3, u.y + py * 3);
        return;
      }
    }

    // In or near the lava: get out.
    if (d0 > R - 2.5) {
      const tx = (-u.x / (d0 || 1)) * Math.min(R * 0.5, 6);
      const ty = (-u.y / (d0 || 1)) * Math.min(R * 0.5, 6);
      if (d0 > R + 0.5 && ready('teleport')) return this.cast(s, 'teleport', tx, ty);
      if (d0 > R + 1.5 && ready('thrust')) return this.cast(s, 'thrust', tx, ty);
      u.order(tx, ty);
    } else if (target) {
      if (Math.random() < 0.05) b.strafe = -b.strafe;
      const want = Math.min(11, R * 0.6);
      const ax = u.x - target.x;
      const ay = u.y - target.y;
      const al = Math.hypot(ax, ay) || 1;
      let mx = target.x + (ax / al) * want + (-ay / al) * 4 * b.strafe;
      let my = target.y + (ay / al) * want + (ax / al) * 4 * b.strafe;
      // Prefer being closer to the centre than the target is.
      mx *= 0.8;
      my *= 0.8;
      const ml = Math.hypot(mx, my);
      if (ml > R - 3) {
        mx *= (R - 3) / ml;
        my *= (R - 3) / ml;
      }
      u.order(mx, my);
    }

    if (!target || b.castLock > 0 || u.buffs.invuln > 0) return;
    const lead = (speed) => {
      const t = td / speed;
      return [target.x + target.mx * t * rand(0.5, 1.1) + rand(-0.8, 0.8), target.y + target.my * t * rand(0.5, 1.1) + rand(-0.8, 0.8)];
    };
    const tNearLava = Math.hypot(target.x, target.y) > R - 6;
    const S = SPELLS;
    const options = [];
    if (ready('fireball') && td < stat(S.fireball, 'range', s.spells.fireball)) options.push(['fireball', ...lead(S.fireball.speed)]);
    if (ready('lightning') && td < S.lightning.range) options.push(['lightning', target.x, target.y]);
    if (ready('homing') && td < 25) options.push(['homing', target.x, target.y]);
    if (ready('bouncer') && td < S.bouncer.range) options.push(['bouncer', ...lead(S.bouncer.speed)]);
    if (ready('boomerang') && td < S.boomerang.range) options.push(['boomerang', ...lead(S.boomerang.speed)]);
    if (ready('drain') && td < S.drain.range) options.push(['drain', ...lead(S.drain.speed)]);
    if (ready('meteor') && td < S.meteor.range) options.push(['meteor', ...lead(td / 1.15)]);
    if (ready('thrust') && td < S.thrust.range * 0.8 && tNearLava) options.push(['thrust', target.x, target.y]);
    if (ready('gravity') && td < 14) options.push(['gravity', target.x, target.y]);
    if (ready('link') && td < S.link.range) options.push(['link', ...lead(S.link.speed)]);
    if (ready('swap') && td < S.swap.range && !tNearLava && d0 > R - 5) options.push(['swap', ...lead(S.swap.speed)]);
    if (ready('scourge') && td < S.scourge.aoe && u.hp > 30) options.push(['scourge', u.x, u.y]);
    if (ready('windwalk') && Math.random() < 0.08) options.push(['windwalk', u.x, u.y]);
    if (!options.length || Math.random() < 0.35) return;
    const [id, x, y] = pick(options);
    this.cast(s, id, x, y);
    b.castLock = rand(0.4, 1.0);
  }

  // --------------------------------------------------------------- snapshot

  snapshot(pid) {
    const ents = [];
    for (const s of this.ps.values()) {
      const u = s.unit;
      if (!u) continue;
      const invis = u.buffs.invis > 0;
      if (invis && s.id !== pid && u.alive) continue;
      const fx = [];
      const extra = { kp: round1(u.kbPoints) };
      if (u.buffs.shield > 0) {
        fx.push('shield');
        extra.sr = round1(u.buffs.shieldR);
      }
      if (u.buffs.absorb > 0) fx.push('rush');
      if (u.buffs.slow > 0) fx.push('slow');
      if (u.buffs.invuln > 0) fx.push('invuln');
      if (invis) fx.push('invis');
      if (u.flags.burn && u.alive) fx.push('burn');
      if (u.buffs.dash) fx.push('dash');
      if (u.casting) fx.push('casting');
      if (u.stun > 100) fx.push('frozen');
      if (fx.length) extra.fx = fx;
      ents.push(unitSnap(u, extra));
    }
    // Velocity and age let clients place projectiles exactly between snapshots.
    for (const p of this.projectiles) ents.push({ id: p.id, k: 'p_' + p.kind, x: round2(p.x), y: round2(p.y), vx: round2(p.vx), vy: round2(p.vy), a: round2(p.age), o: p.owner });
    for (const m of this.meteors) ents.push({ id: m.id, k: 'meteor', x: round2(m.x), y: round2(m.y), r: round2(m.aoe), t: round2(1 - m.t / m.delay), o: m.owner });
    if (this.phase !== 'shop') for (const o of this.obstacles) ents.push({ id: o.id, k: 'obstacle', x: round2(o.x), y: round2(o.y), r: round2(o.r) });

    const players = {};
    for (const s of this.ps.values()) {
      players[s.id] = { g: Math.floor(s.gold), k: s.kills, a: s.assists, w: s.wins, sc: s.score, d: round1(s.dmg), sp: s.spells, sl: s.slots, it: s.items, rd: s.ready };
    }
    const me = this.ps.get(pid);
    const snap = {
      mode: 'warlock',
      phase: this.phase,
      ff: this.fastForward && this.phase === 'play' ? FAST_FORWARD : undefined,
      timer: round1(this.timer),
      round: this.round,
      rounds: this.rounds,
      arena: { r: round2(this.arenaR), lava: WARLOCK.lavaDps },
      ents,
      links: this.links.map((l) => [this.ps.get(l.a)?.unit?.id, this.ps.get(l.b)?.unit?.id]),
      players,
      me: me ? { cd: Object.fromEntries(Object.entries(me.cds).filter(([, v]) => v > 0).map(([k, v]) => [k, round1(v)])), uid: me.unit?.id, pr: this.predictState(me) } : null,
    };
    if (this.phase === 'over') snap.standings = this.standings();
    return snap;
  }

  // ---------------------------------------------------------------- helpers

  units() {
    return [...this.ps.values()].map((s) => s.unit).filter(Boolean);
  }

  onLeave(pid) {
    const s = this.ps.get(pid);
    if (s) s.ready = true;
  }

  name(pid) {
    return this.room.nameOf(pid);
  }

  msg(text, color) {
    this.ev({ k: 'msg', text, c: color });
  }

  ev(e) {
    this.events.push(e);
  }
}
