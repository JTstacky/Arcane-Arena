// Small shared simulation helpers: WC3-style "click to move" units with a
// separate knockback velocity that decays with friction, plus unit-unit
// collision.

let nextId = 1;
export const newId = () => nextId++;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};
export const round1 = (v) => Math.round(v * 10) / 10;
export const round2 = (v) => Math.round(v * 100) / 100;
export const wrapAngle = (a) => {
  a = (a + Math.PI) % (Math.PI * 2);
  return (a < 0 ? a + Math.PI * 2 : a) - Math.PI;
};

// Warcraft III movement model, as measured in the real engine (see
// docs/wc3-observations.md, sections 1-2 and 9).
//  - Units steer by a logical *heading* that turns once per 0.03 s step by at
//    most Turn Rate radians (0.6 rad = 34.4° per step for the warlock).
//  - Propulsion Window (60°): each step first checks whether the heading,
//    *before* this step's turn, is within the window of the target. If so the
//    unit walks during the step, along the heading *after* the turn.
//  - Walking is full speed at once, with no acceleration or deceleration. The
//    unit stops dead about 11 units short of the clicked point.
//  - The drawn model uses a separate, slower *display* facing: 0.07, then
//    0.14, then at most min(turnRate, 0.2) rad per step, easing into the final
//    angle. So after a 180° order the unit visibly slides backwards for about
//    0.35 s.
//  - Knockback is a separate velocity. Every step: v *= friction, then
//    pos += v (the Warlock map's script loop).
export const WC3 = {
  STEP: 0.03,
  DISPLAY_TURN: [0.07, 0.14, 0.2], // rad per step while the model catches up
  DISPLAY_EASE: 0.7, // share of the remaining angle covered per step at the end
  DEFAULT_TURN_RATE: 0.6,
  DEFAULT_PROP_WINDOW: (60 * Math.PI) / 180,
  ARRIVE: 11 / 50, // metres short of the target where a move order ends
};

export class Unit {
  constructor({ kind, owner = null, x = 0, y = 0, r = 0.6, speed = 5, hp = 0 }) {
    this.id = newId();
    this.kind = kind;
    this.owner = owner;
    this.x = x;
    this.y = y;
    this.r = r;
    this.speed = speed;
    this.speedMult = 1;
    this.vx = 0; // knockback velocity
    this.vy = 0;
    this.mx = 0; // last movement velocity (for bots / rendering)
    this.my = 0;
    this.heading = 0; // logical facing the unit steers by
    this.facing = 0; // display facing (the drawn model)
    this.dispStep = 0; // steps the display facing has spent catching up
    this.turnRate = WC3.DEFAULT_TURN_RATE; // radians per 0.03 s step (object-editor units)
    this.propWindow = WC3.DEFAULT_PROP_WINDOW;
    this.target = null; // {x, y} move order
    this.alive = true;
    this.hp = hp;
    this.maxHp = hp;
    this.stun = 0;
    this.kbResist = 1; // multiplier on knockback received
    this.mass = 1;
    this.solid = true;
    this.flags = {};
  }

  setFacing(a) {
    this.heading = this.facing = wrapAngle(a);
    this.dispStep = 0;
  }

  order(x, y) {
    this.target = { x, y };
  }

  stop() {
    this.target = null;
  }

  // Turns the heading one step toward `want` and returns the angle still
  // left to turn afterwards.
  turnStep(want, dt) {
    const diff = wrapAngle(want - this.heading);
    const max = this.turnRate * (dt / WC3.STEP);
    this.heading = wrapAngle(this.heading + clamp(diff, -max, max));
    return Math.abs(wrapAngle(want - this.heading));
  }

  // The drawn model chases the heading more slowly than the unit steers.
  updateDisplay(dt) {
    const diff = wrapAngle(this.heading - this.facing);
    if (Math.abs(diff) < 0.005) {
      this.facing = this.heading;
      this.dispStep = 0;
      return;
    }
    const k = dt / WC3.STEP;
    const ramp = WC3.DISPLAY_TURN[Math.min(this.dispStep, WC3.DISPLAY_TURN.length - 1)];
    const cap = Math.min(ramp, Math.max(this.turnRate, 0.07)) * k;
    const step = Math.max(Math.min(cap, Math.abs(diff) * Math.min(1, WC3.DISPLAY_EASE * k)), 0.005);
    this.facing = wrapAngle(this.facing + Math.sign(diff) * Math.min(step, Math.abs(diff)));
    this.dispStep++;
  }

  knock(dx, dy, force) {
    const l = Math.hypot(dx, dy) || 1;
    this.vx += (dx / l) * force * this.kbResist;
    this.vy += (dy / l) * force * this.kbResist;
  }

  get kbSpeed() {
    return Math.hypot(this.vx, this.vy);
  }
}

// Moves every living unit one 0.03 s step. `friction` multiplies knockback
// velocity once per step (Warlock: 0.96). With `controlLoss`, heavy
// knockback also reduces walking speed.
export function stepUnits(units, dt, { friction = 0.9, controlLoss = true } = {}) {
  const k = dt / WC3.STEP;
  for (const u of units) {
    if (!u.alive) continue;
    if (u.stun > 0) u.stun -= dt;

    u.mx = 0;
    u.my = 0;
    u.turning = false;
    if (u.target && u.stun <= 0) {
      const dx = u.target.x - u.x;
      const dy = u.target.y - u.y;
      const d = Math.hypot(dx, dy);
      if (d <= WC3.ARRIVE) {
        u.target = null;
      } else {
        const want = Math.atan2(dy, dx);
        // The propulsion window is tested on the heading before this step's turn.
        const walk = Math.abs(wrapAngle(want - u.heading)) <= u.propWindow + 1e-6;
        u.turning = u.turnStep(want, dt) > 1e-3;
        if (walk) {
          const sp = u.speed * u.speedMult * (controlLoss ? clamp(1 - u.kbSpeed / 18, 0.25, 1) : 1);
          const step = Math.min(sp * dt, d - WC3.ARRIVE);
          u.mx = Math.cos(u.heading) * sp;
          u.my = Math.sin(u.heading) * sp;
          u.x += Math.cos(u.heading) * step;
          u.y += Math.sin(u.heading) * step;
          if (d - step <= WC3.ARRIVE + 1e-6) u.target = null;
        }
      }
    }
    u.updateDisplay(dt);

    // Knockback: friction first, then move, as in the script.
    if (u.vx || u.vy) {
      const f = Math.pow(friction, k);
      u.vx *= f;
      u.vy *= f;
      u.x += u.vx * dt;
      u.y += u.vy * dt;
      if (u.vx * u.vx + u.vy * u.vy < 1e-6) u.vx = u.vy = 0;
    }
  }
}

// Keeps solid units from overlapping (the engine's pathing). With
// `swap: true`, two units that run into each other swap knockback velocities,
// as in the Warlock script: a warlock flying across the arena stops dead and
// the one it hits flies on. Otherwise fast units pass on part of their
// momentum. `skip(a, b)` can exempt a pair from the exchange.
export function collideUnits(units, { swap = false, skip = null } = {}) {
  for (let i = 0; i < units.length; i++) {
    const a = units[i];
    if (!a.alive || !a.solid) continue;
    for (let j = i + 1; j < units.length; j++) {
      const b = units[j];
      if (!b.alive || !b.solid) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const minD = a.r + b.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minD * minD) continue;
      const d = Math.sqrt(d2) || 0.001;
      const nx = dx / d;
      const ny = dy / d;
      const overlap = minD - d;
      const tm = a.mass + b.mass;
      a.x -= nx * overlap * (b.mass / tm);
      a.y -= ny * overlap * (b.mass / tm);
      b.x += nx * overlap * (a.mass / tm);
      b.y += ny * overlap * (a.mass / tm);
      const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
      if (swap) {
        if (rel > 0 && !skip?.(a, b)) {
          [a.vx, b.vx] = [b.vx, a.vx];
          [a.vy, b.vy] = [b.vy, a.vy];
        }
      } else if (rel > 2) {
        const imp = rel * 0.6;
        a.vx -= nx * imp * (b.mass / tm);
        a.vy -= ny * imp * (b.mass / tm);
        b.vx += nx * imp * (a.mass / tm);
        b.vy += ny * imp * (a.mass / tm);
      }
    }
  }
}

export function clampToRect(u, hw, hh) {
  u.x = clamp(u.x, -hw + u.r, hw - u.r);
  u.y = clamp(u.y, -hh + u.r, hh - u.r);
}

export function clampToCircle(u, R) {
  const d = Math.hypot(u.x, u.y);
  const max = R - u.r;
  if (d > max) {
    u.x *= max / d;
    u.y *= max / d;
  }
}

export function unitSnap(u, extra = {}) {
  const s = { id: u.id, k: u.kind, x: round2(u.x), y: round2(u.y), f: round2(u.facing) };
  if (u.owner != null) s.o = u.owner;
  if (u.maxHp) {
    s.hp = Math.round(u.hp * 10) / 10;
    s.mhp = u.maxHp;
  }
  if (!u.alive) s.dead = 1;
  if (u.mx || u.my) s.mv = 1;
  else if (u.turning) s.tn = 1;
  return Object.assign(s, extra);
}
