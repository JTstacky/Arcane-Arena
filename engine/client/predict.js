// Client-side prediction for the player's own hero, so it reacts the moment
// an order is given instead of a network round trip later.
//
// Each snapshot carries the hero's exact movement state (`me.pr`) and the
// sequence number of the last order the host handled. From that state the
// client re-runs the host's own 0.03 s steps (stepUnits, the same code), with
// the orders the host hasn't handled yet replayed at the moment they will
// reach it, up to the time the host will be handling an order given now.
// Anything the client can't foresee (a hit, a collision, a teleport) arrives
// in the next snapshot; the difference is blended out over a few frames, or
// snapped if it is a jump.

import { Unit, stepUnits, WC3, wrapAngle } from '../server/sim.js';

const STEP = WC3.STEP;
const MAX_STEPS = 24; // never simulate more than 0.72 s ahead
const SNAP_DIST = 3; // metres: a bigger correction is a jump, not drift
const BLEND = 12; // how fast a correction is blended out (per second)

export class Predictor {
  // `rules`: { friction, castPoint, spells: { id: { castTime, self } } }.
  constructor(rules) {
    this.rules = rules;
    this.seq = 0;
    this.log = []; // recent orders: { q, m, at } (local send time)
    this.rtts = [];
    this.rtt = 0.1;
    this.ahead = null; // how far ahead the hero is shown; eases toward rtt
    this.base = null; // { pr, tick }
    this.used = null; // the base last frame's prediction was made from
    this.unit = new Unit({ kind: 'predict' });
    this.err = { x: 0, y: 0 };
    this.out = { x: 0, y: 0, f: 0, moving: false, turning: false, casting: false };
  }

  // A new game: its host knows none of the orders logged so far.
  reset() {
    this.log.length = 0;
    this.base = this.used = null;
    this.err.x = this.err.y = 0;
  }

  // Tags an outgoing order with a sequence number and remembers it.
  order(m) {
    if (m.t !== 'cmd' || !(m.c === 'move' || m.c === 'stop' || m.c === 'cast')) return m;
    m.q = ++this.seq;
    this.log.push({ q: m.q, m, at: performance.now() / 1000 });
    if (this.log.length > 64) this.log.shift();
    return m;
  }

  // A new snapshot: measure the round trip and rebase.
  snapshot(snap) {
    const pr = snap.me?.pr;
    if (!pr) {
      this.base = this.used = null;
      return;
    }
    const acked = this.log.find((o) => o.q === pr.sq);
    if (acked && !acked.rtt) {
      // Send to "handled and reported" is the round trip plus up to a
      // snapshot interval of waiting; the smallest recent sample is closest.
      acked.rtt = performance.now() / 1000 - acked.at;
      this.rtts.push(acked.rtt);
      if (this.rtts.length > 20) this.rtts.shift();
      this.rtt = Math.min(...this.rtts);
    }
    this.base = { pr, tick: snap.tk };
  }

  // The predicted hero for this frame, or null. `serverNow` is the host's
  // clock as best known (local time minus the clock offset).
  frame(serverNow, dt) {
    const b = this.base;
    if (!b) return null;
    const localToHost = serverNow - performance.now() / 1000;
    // Orders take effect about a round trip after they are sent (in host
    // time); show the hero as it will be when an order given now lands.
    // The lead eases toward a changed round trip (at up to a quarter of real
    // time) so the hero never skips forward or back when the estimate moves.
    if (this.ahead == null) this.ahead = this.rtt;
    else this.ahead += Math.max(-0.25 * dt, Math.min(0.25 * dt, this.rtt - this.ahead));
    const at = serverNow + this.ahead;
    const cur = this.simulate(b, at, localToHost);
    let x = cur.x;
    let y = cur.y;
    if (this.used && this.used !== b) {
      // A new snapshot moved the prediction: keep the hero where it was
      // shown and blend the difference out, unless it is a jump.
      const old = this.simulate(this.used, at, localToHost);
      this.err.x += old.x - x;
      this.err.y += old.y - y;
      if (Math.hypot(this.err.x, this.err.y) > SNAP_DIST) this.err.x = this.err.y = 0;
    }
    this.used = b;
    const k = Math.exp(-BLEND * dt);
    this.err.x *= k;
    this.err.y *= k;
    const o = this.out;
    o.x = x + this.err.x;
    o.y = y + this.err.y;
    o.f = cur.f;
    o.moving = cur.moving;
    o.turning = cur.turning;
    o.casting = cur.casting;
    return o;
  }

  // Runs the hero from a snapshot's state to host time `at`, applying the
  // orders the host hadn't handled yet when they reach it.
  simulate(base, at, localToHost) {
    const u = this.load(base.pr);
    const t0 = base.tick * STEP;
    const span = Math.max(0, at - t0);
    const steps = Math.min(MAX_STEPS, Math.floor(span / STEP));
    const frac = Math.min(1, span / STEP - steps);
    const lead = this.rtt;
    const log = this.log;
    let i = 0;
    while (i < log.length && log[i].q <= base.pr.sq) i++;
    const r = this._r || (this._r = {});
    // One step past `at`, so the hero can be drawn between the two steps it
    // falls between, as the host's own motion is (steps are 0.03 s apart).
    for (let n = 0; n <= steps; n++) {
      // The host handles an order that arrives during a step's interval just
      // before that step runs.
      const tNext = t0 + (n + 1) * STEP;
      while (i < log.length && log[i].at + localToHost + lead <= tNext + 1e-6) this.apply(u, log[i++].m);
      if (n === steps) {
        r.x = u.x;
        r.y = u.y;
        r.f = u.facing;
      }
      this.step(u);
    }
    r.x += (u.x - r.x) * frac;
    r.y += (u.y - r.y) * frac;
    r.f += wrapAngle(u.facing - r.f) * frac;
    r.moving = !!(u.mx || u.my);
    r.turning = !!u.turning;
    r.casting = !!u.casting;
    return { ...r };
  }

  // ------------------------------------------------ the host's rules, mirrored

  load(pr) {
    const u = this.unit;
    u.x = pr.x;
    u.y = pr.y;
    u.heading = pr.h;
    u.facing = pr.f;
    u.dispStep = pr.ds || 0;
    u.target = pr.t ? { x: pr.t[0], y: pr.t[1] } : null;
    u.vx = pr.v[0];
    u.vy = pr.v[1];
    u.speed = pr.sp;
    u.speedMult = 1;
    u.turnRate = pr.tr;
    u.propWindow = pr.pw;
    u.stun = pr.st;
    this.castPoint = pr.cp ?? this.rules.castPoint; // the host's -castpoint tuning
    u.alive = true;
    u.casting = pr.c ? { id: pr.c.id, tx: pr.c.x, ty: pr.c.y, lock: pr.c.l, charge: pr.c.g } : null;
    u.queued = pr.q ? { ...pr.q } : null;
    u.dash = pr.d ? { vx: pr.d[0], vy: pr.d[1], t: pr.d[2] } : null;
    u.cds = { ...pr.cd };
    u.mx = u.my = 0;
    return u;
  }

  apply(u, m) {
    if (m.c === 'cast') return this.cast(u, m.spell, m.x, m.y);
    const order = m.c === 'move' ? { c: 'move', x: m.x, y: m.y } : { c: 'stop' };
    if (u.casting?.lock || u.casting?.charge > 0 || u.dash) u.queued = order;
    else {
      u.casting = null;
      this.doOrder(u, order);
    }
  }

  doOrder(u, o) {
    if (o.c === 'move') u.target = { x: o.x, y: o.y };
    else if (o.c === 'stop') u.target = null;
    else if (o.c === 'cast') this.cast(u, o.id, o.x, o.y);
  }

  cast(u, id, tx, ty) {
    const def = this.rules.spells[id];
    if (!def || u.stun > 0) return;
    if (u.casting?.lock || u.casting?.charge > 0 || u.dash) {
      u.queued = { c: 'cast', id, x: tx, y: ty };
      return;
    }
    if ((u.cds[id] || 0) > 0) return;
    u.target = null;
    u.queued = null;
    u.casting = { id, tx, ty, lock: 0, charge: null };
    if (def.self || Math.abs(wrapAngle(Math.atan2(ty - u.y, tx - u.x) - u.heading)) < 1e-3) this.begin(u);
  }

  begin(u) {
    const c = u.casting;
    const def = this.rules.spells[c.id];
    if ((u.cds[c.id] || 0) > 0) {
      u.casting = null;
      return;
    }
    if (def.castTime && c.charge == null) {
      c.charge = def.castTime;
      u.target = null;
      return;
    }
    c.lock = this.castPoint;
    u.cds[c.id] = 1; // blocks a re-cast; the real cooldown comes from the host
    if (def.dash) {
      // Thrust: the dash starts as the spell goes off.
      const dx = c.tx - u.x;
      const dy = c.ty - u.y;
      const d = Math.hypot(dx, dy) || 1;
      const range = Math.min(d, def.dash.range);
      u.dash = { vx: (dx / d) * def.dash.speed, vy: (dy / d) * def.dash.speed, t: range / def.dash.speed };
      u.target = null;
    }
  }

  step(u) {
    const c = u.casting;
    if (c) {
      if (c.charge > 0) {
        c.charge -= STEP;
        if (c.charge <= 1e-6) {
          c.charge = 0;
          this.begin(u);
        }
      } else if (c.lock > 0) {
        c.lock -= STEP;
        if (c.lock <= 1e-6) {
          u.casting = null;
          const q = u.queued;
          u.queued = null;
          if (q) this.doOrder(u, q);
        }
      } else {
        const want = Math.atan2(c.ty - u.y, c.tx - u.x);
        if (Math.abs(wrapAngle(want - u.heading)) < 1e-3) this.begin(u);
        else u.turnStep(want, STEP);
      }
    }
    for (const k in u.cds) u.cds[k] -= STEP;
    if (u.dash) {
      u.x += u.dash.vx * STEP;
      u.y += u.dash.vy * STEP;
      u.setFacing(Math.atan2(u.dash.vy, u.dash.vx));
      u.dash.t -= STEP;
      if (u.dash.t <= 0) {
        u.dash = null;
        const q = u.queued;
        u.queued = null;
        if (q) this.doOrder(u, q);
      }
    }
    stepUnits([u], STEP, { friction: this.rules.friction, controlLoss: false });
  }
}
