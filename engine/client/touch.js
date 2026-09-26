// Touch controls for phones and tablets, laid over the WC3 mouse controls:
//  - a virtual joystick (bottom left) walks the hero: while it is held, a move
//    order to a point a little ahead of the hero is re-sent every 100 ms, and
//    letting go sends stop;
//  - a tap anywhere on the battlefield casts the default attack (Arcane
//    Arena: fireball) toward that spot; a tap near a rival snaps to the rival;
//  - the command card becomes big buttons at the bottom right. A button arms
//    its spell for the next tap only, then taps go back to the default
//    attack. Tap the same button again to disarm it. Self-cast spells
//    (shield…) fire at once;
//  - the camera always follows the hero at a fixed distance (no zoom or pan).

import { unlockAudio } from './audio.js';

const RESEND_MS = 100;
const AHEAD = 3; // metres ahead of the hero the joystick's move order points
const DEAD = 12; // joystick dead zone, px
const TAP_MOVE = 14; // a touch that moves further than this is a drag, not a tap
const SNAP = 2.5; // metres: a tap this close to a rival targets the rival

export class Touch {
  constructor({ world, input, send, getMyId, defaultSlot = null }) {
    this.defaultSlot = defaultSlot; // slot a plain tap casts; null makes a tap a move
    this.world = world;
    this.input = input;
    this.send = send;
    this.getMyId = getMyId;
    this.stick = null; // { id, cx, cy, dx, dy }
    this.moving = false;
    this.lastDir = null;
    this.lastSent = 0;
    this.touches = new Map(); // canvas touches: pointerId -> {x, y, x0, y0}

    document.body.classList.add('touch');
    input.quickCast = false; // no cursor to cast at: always tap a target
    input.touchMode = true;

    const hud = document.getElementById('hud');
    hud.insertAdjacentHTML('beforeend', `
      <div id="joy"><div id="joy-base"><div id="joy-knob"></div></div></div>`);
    document.body.insertAdjacentHTML('beforeend', '<div id="rotate"><div>↻</div><p>Turn your phone sideways to play.</p></div>');

    const joy = document.getElementById('joy');
    joy.addEventListener('pointerdown', (e) => this.stickDown(e));
    joy.addEventListener('pointermove', (e) => this.stickMove(e));
    joy.addEventListener('pointerup', (e) => this.stickUp(e));
    joy.addEventListener('pointercancel', (e) => this.stickUp(e));

    const canvas = world.canvas;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e, true));
    // Stop the browser scrolling, zooming the page or sending mouse clicks.
    for (const el of [canvas, joy]) el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

    // Spell buttons fire on touch-down, not on the later click, and show no
    // tooltip (there is no hover on a phone).
    const card = document.getElementById('cmdcard');
    let cardTouch = 0;
    card.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      const b = e.target.closest('[data-slot]');
      if (!b) return;
      cardTouch = performance.now();
      input.useSlot(+b.dataset.slot);
    });
    card.addEventListener('click', (e) => {
      if (performance.now() - cardTouch < 800) e.stopPropagation();
    }, true);
    card.addEventListener('pointerup', () => setTimeout(() => (document.getElementById('tooltip').hidden = true), 0));

    // The shop fills a phone's screen: other panels step aside while it is open.
    const shop = document.getElementById('shop');
    new MutationObserver(() => document.body.classList.toggle('shopping', !shop.hidden)).observe(shop, { attributes: true, attributeFilter: ['hidden'] });

    // Tapping the top bar shows or hides the scoreboard.
    document.getElementById('topbar').addEventListener('click', () => document.body.classList.toggle('mb-open'));

    // Phones get the whole screen, in landscape where the browser allows it.
    for (const id of ['create', 'join', 'start']) {
      document.getElementById(id)?.addEventListener('click', () => this.fullscreen());
    }

    setInterval(() => this.tick(), RESEND_MS);
  }

  fullscreen() {
    const d = document.documentElement;
    if (document.fullscreenElement || !d.requestFullscreen) return;
    d.requestFullscreen({ navigationUI: 'hide' })
      .then(() => screen.orientation?.lock?.('landscape'))
      .catch(() => {});
  }

  me() {
    return this.world.myView();
  }

  // ------------------------------------------------------------ joystick

  stickDown(e) {
    unlockAudio();
    e.preventDefault();
    if (this.stick) return;
    const r = document.getElementById('joy-base').getBoundingClientRect();
    this.stick = { id: e.pointerId, cx: r.left + r.width / 2, cy: r.top + r.height / 2, dx: 0, dy: 0, max: r.width / 2 };
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId); // keep the stick even if the finger slides off it
    } catch {}
    this.stickMove(e);
  }

  stickMove(e) {
    const s = this.stick;
    if (!s || e.pointerId !== s.id) return;
    let dx = e.clientX - s.cx;
    let dy = e.clientY - s.cy;
    const l = Math.hypot(dx, dy);
    if (l > s.max) {
      dx *= s.max / l;
      dy *= s.max / l;
    }
    s.dx = dx;
    s.dy = dy;
    document.getElementById('joy-knob').style.transform = `translate(${dx}px, ${dy}px)`;
    // Answer a sharp change of direction at once rather than on the next tick.
    const dir = l > DEAD ? Math.atan2(dy, dx) : null;
    if (dir != null && (this.lastDir == null || Math.abs(Math.atan2(Math.sin(dir - this.lastDir), Math.cos(dir - this.lastDir))) > 0.35)) this.steer(true);
  }

  stickUp(e) {
    const s = this.stick;
    if (!s || e.pointerId !== s.id) return;
    this.stick = null;
    this.lastDir = null;
    document.getElementById('joy-knob').style.transform = '';
    if (this.moving) {
      this.moving = false;
      // Don't cancel a spell that is still turning to face its target.
      const wait = Math.max(0, this.input.holdPause - performance.now());
      setTimeout(() => {
        if (!this.stick) this.send({ t: 'cmd', c: 'stop' });
      }, wait);
    }
  }

  tick() {
    if (this.stick) this.steer(false);
  }

  // Sends a move order a few metres ahead of the hero in the stick's direction.
  steer(now) {
    const s = this.stick;
    if (!s || !this.input.active) return;
    if (Math.hypot(s.dx, s.dy) <= DEAD) return;
    if (performance.now() < this.input.holdPause) return; // let a cast begin
    if (!now && performance.now() - this.lastSent < RESEND_MS - 10) return;
    const u = this.me();
    if (!u) return;
    // The camera looks straight north, so screen right is +x and down is +z.
    const dir = Math.atan2(s.dy, s.dx);
    const x = u.x + Math.cos(dir) * AHEAD;
    const y = u.z + Math.sin(dir) * AHEAD;
    this.send({ t: 'cmd', c: 'move', x: +x.toFixed(2), y: +y.toFixed(2) });
    this.lastDir = dir;
    this.lastSent = performance.now();
    this.moving = true;
  }

  // -------------------------------------------------------------- taps

  down(e) {
    if (e.pointerType === 'mouse') return;
    unlockAudio();
    this.input.lastTouch = performance.now();
    this.world.follow = true;
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
  }

  move(e) {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    t.x = e.clientX;
    t.y = e.clientY;
  }

  up(e, cancelled = false) {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    this.input.lastTouch = performance.now();
    this.touches.delete(e.pointerId);
    if (cancelled || Math.hypot(t.x - t.x0, t.y - t.y0) > TAP_MOVE) return;
    this.tap(t.x, t.y);
  }

  tap(x, y) {
    const input = this.input;
    if (!input.active) return;
    const p = this.world.screenToGround(x, y);
    if (!p) return;
    if (input.targeting) {
      input.castAt(input.targeting, this.snap(p));
      input.cancelTarget();
    } else if (this.defaultSlot != null) {
      input.castSlotAt(this.defaultSlot, this.snap(p));
    } else {
      this.send({ t: 'cmd', c: 'move', x: +p.x.toFixed(2), y: +p.y.toFixed(2) });
      this.world.moveMarker(p.x, p.y);
    }
  }

  // The nearest living rival within SNAP of the tap, or the tap itself.
  snap(p) {
    const myId = this.getMyId();
    let best = null;
    let bd = SNAP;
    for (const v of this.world.views.values()) {
      if (v.k !== 'warlock' || v.owner === myId || v.deadT > 0 || !v.obj.visible) continue;
      const d = Math.hypot(v.x - p.x, v.z - p.y);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best ? { x: best.x, y: best.z } : p;
  }
}
