// Small shared simulation helpers: WC3-style "click to move" units with a
// separate knockback velocity that decays with friction, plus unit-unit
// collision. Used by Warlock and by every Uther Party minigame.

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

// Warcraft III movement model.
//  - The engine updates unit facing every 0.03 s "frame". The object-editor
//    Turn Rate is in radians per frame, but rotation speed is capped at
//    ~0.2 rad/frame (~382°/s, measured in game); higher values only raise the
//    angular acceleration. Units ease in and out of turns.
//  - Propulsion Window (default 60°): a unit only walks while facing within
//    that angle of where it is going; otherwise it turns on the spot first.
//    It always walks in the direction it faces, so turns become short arcs.
export const WC3 = {
  FRAME: 0.03,
  MAX_TURN_PER_FRAME: 0.2,
  DEFAULT_TURN_RATE: 0.5,
  DEFAULT_PROP_WINDOW: (60 * Math.PI) / 180,
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
    this.facing = 0;
    this.angVel = 0;
    this.turnRate = WC3.DEFAULT_TURN_RATE; // radians per 0.03 s frame (object editor units)
    this.propWindow = WC3.DEFAULT_PROP_WINDOW;
    this.faceTo = null; // angle to turn toward when not moving (e.g. while casting)
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

  order(x, y) {
    this.target = { x, y };
    this.faceTo = null;
  }

  stop() {
    this.target = null;
  }

  // Rotates toward `desired` with WC3-style capped, eased angular velocity.
  // Returns the remaining angle.
  turnToward(desired, dt) {
    const F = WC3.FRAME;
    const diff = wrapAngle(desired - this.facing);
    const maxV = Math.min(this.turnRate, WC3.MAX_TURN_PER_FRAME) / F;
    const acc = (this.turnRate * WC3.MAX_TURN_PER_FRAME) / (F * F);
    const want = Math.sign(diff) * Math.min(maxV, Math.sqrt(2 * acc * Math.abs(diff)));
    this.angVel += clamp(want - this.angVel, -acc * dt, acc * dt);
    const step = this.angVel * dt;
    if (Math.abs(diff) < 1e-3 || (Math.sign(step) === Math.sign(diff) && Math.abs(step) >= Math.abs(diff))) {
      this.facing = desired;
      this.angVel = 0;
      return 0;
    }
    this.facing = wrapAngle(this.facing + step);
    return Math.abs(wrapAngle(desired - this.facing));
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

// Moves every living unit one step. `friction` is the exponential decay rate
// of knockback velocity; `linear` a constant deceleration so knockback ends.
export function stepUnits(units, dt, { friction = 2.4, linear = 1.2, controlLoss = true } = {}) {
  for (const u of units) {
    if (!u.alive) continue;
    if (u.stun > 0) u.stun -= dt;

    // Movement from orders, WC3 style: turn, then walk along the facing.
    // Heavy knockback reduces how much control you have (minigames only).
    u.mx = 0;
    u.my = 0;
    u.turning = false;
    if (u.target && u.stun <= 0) {
      const dx = u.target.x - u.x;
      const dy = u.target.y - u.y;
      const d = Math.hypot(dx, dy);
      const sp = u.speed * u.speedMult * (controlLoss ? clamp(1 - u.kbSpeed / 18, 0.25, 1) : 1);
      const step = sp * dt;
      if (d <= Math.max(step, 0.02)) {
        u.x = u.target.x;
        u.y = u.target.y;
        u.target = null;
      } else {
        const rem = u.turnToward(Math.atan2(dy, dx), dt);
        u.turning = rem > 0;
        if (rem <= u.propWindow) {
          // Close to the goal, head straight in so we never orbit it.
          const dirX = d < step * 3 ? dx / d : Math.cos(u.facing);
          const dirY = d < step * 3 ? dy / d : Math.sin(u.facing);
          u.mx = dirX * sp;
          u.my = dirY * sp;
          u.x += u.mx * dt;
          u.y += u.my * dt;
        }
      }
    } else if (u.faceTo != null && u.stun <= 0) {
      u.turning = u.turnToward(u.faceTo, dt) > 0;
      if (!u.turning) u.faceTo = null;
    } else {
      u.angVel = 0;
    }

    // Knockback.
    const s = u.kbSpeed;
    if (s > 0) {
      u.x += u.vx * dt;
      u.y += u.vy * dt;
      const decay = Math.exp(-friction * dt);
      const ns = Math.max(0, s * decay - linear * dt);
      const k = ns / s;
      u.vx *= k;
      u.vy *= k;
    }
  }
}

// Pushes overlapping solid units apart. Fast-moving (knocked) units transfer
// part of their momentum, so a warlock flying across the arena can bowl
// another one over — a very Warlock thing to happen.
export function collideUnits(units) {
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
      // Exchange knockback momentum along the collision normal.
      const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
      if (rel > 2) {
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
    s.hp = Math.ceil(u.hp);
    s.mhp = u.maxHp;
  }
  if (!u.alive) s.dead = 1;
  if (u.mx || u.my) s.mv = 1;
  else if (u.turning) s.tn = 1;
  return Object.assign(s, extra);
}
