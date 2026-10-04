// Aimed casting, MOBA style, for phones (drag from a spell button) and
// gamepads (hold a spell button, aim with the right stick): the spell goes in
// a direction from your warlock rather than at a tapped point. A band on the
// ground shows where it will go; letting go casts it.
//  - Spells whose distance matters (Meteor, Teleport, Thrust, Boomerang) go
//    as far as the drag or stick is pushed; the rest fly their full range.
//  - With no direction (a quick tap, a centred stick) the spell goes at the
//    nearest rival, or straight ahead if nobody is in reach. Spells that are
//    tap-targeted instead (Teleport) go straight ahead.

// The nearest living rival warlock within `max` metres of (x, z), or null.
export function nearestRival(world, myId, x, z, max) {
  let best = null;
  let bd = max;
  for (const v of world.views.values()) {
    if (v.k !== 'warlock' || v.owner === myId || v.deadT > 0 || !v.obj.visible) continue;
    const d = Math.hypot(v.x - x, v.z - z);
    if (d < bd) {
      bd = d;
      best = v;
    }
  }
  return best;
}

export class Aim {
  constructor({ world, input }) {
    this.world = world;
    this.input = input;
    this.cur = null; // { slot, a, dx, dy, push, cancel }
    this.p = { x: 0, y: 0, range: null, aoe: null, cancel: false };
  }

  // Starts aiming the spell in slot `i`. Spells that need no aim (self-casts)
  // and errors ("not ready") are handled at once; returns true if aiming.
  start(i) {
    const input = this.input;
    const snap = input.getSnap();
    if (!snap || !input.active) return false;
    const a = input.slots.action(i, snap, input.getMyId());
    if (!a) return false;
    if (!a.target) {
      input.useSlot(i);
      return false;
    }
    this.cur = { slot: i, a, dx: 0, dy: 0, push: 0, cancel: false };
    this.show();
    return true;
  }

  // Sets the aim: (dx, dy) a direction on screen (right, down), `push` 0..1
  // how far for distance spells. A zero vector means no direction yet.
  set(dx, dy, push, cancel = false) {
    const c = this.cur;
    if (!c) return;
    c.dx = dx;
    c.dy = dy;
    c.push = push;
    c.cancel = cancel;
    this.show();
  }

  // Keeps the band on the warlock as it moves.
  frame() {
    if (this.cur) this.show();
  }

  show() {
    this.world.showAim(this.point());
  }

  // Where the spell would land now, or null.
  point() {
    const c = this.cur;
    const me = c && this.world.myView();
    if (!me) return null;
    const range = c.a.range ?? 14;
    const p = this.p;
    let ux;
    let uy;
    let dist;
    const len = Math.hypot(c.dx, c.dy);
    if (len > 0) {
      ux = c.dx / len;
      uy = c.dy / len;
      dist = c.a.point ? Math.max(1, c.push * range) : range;
    } else {
      const r = !c.a.tapTarget && nearestRival(this.world, this.input.getMyId(), me.x, me.z, range * 1.25);
      if (r) {
        ux = r.x - me.x;
        uy = r.z - me.z;
        dist = Math.hypot(ux, uy) || 1;
        ux /= dist;
        uy /= dist;
        dist = Math.min(dist, range);
      } else {
        const f = -me.obj.rotation.y; // the model's facing
        ux = Math.cos(f);
        uy = Math.sin(f);
        dist = c.a.point ? range * 0.6 : range;
      }
    }
    p.x = me.x + ux * dist;
    p.y = me.z + uy * dist;
    p.range = c.a.range;
    p.aoe = c.a.aoe;
    p.cancel = c.cancel;
    return p;
  }

  // Casts the aimed spell (unless cancelled) and stops aiming.
  release() {
    const c = this.cur;
    if (!c) return;
    const p = this.point();
    this.stop();
    if (c.cancel || !p) return;
    // It may have come off cooldown or gone on it meanwhile: ask again.
    this.input.castSlotAt(c.slot, { x: p.x, y: p.y });
  }

  stop() {
    this.cur = null;
    this.world.showAim(null);
  }
}
