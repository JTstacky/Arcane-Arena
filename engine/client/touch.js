// Touch controls for phones and tablets, laid over the WC3 mouse controls:
//  - a virtual joystick (bottom left) walks the hero: while it is held, a move
//    order to a point a little ahead of the hero is re-sent every 100 ms, and
//    centring or letting go of it stops;
//  - a tap anywhere on the battlefield casts the default attack (Arcane
//    Arena: fireball) toward that spot; a tap near a rival snaps to the rival.
//    The default attack has no button, only a small cooldown dial in the
//    corner (unless the player gives it a button, see below);
//  - the spell buttons cluster in the bottom-right corner (or run up the right
//    edge). Two control schemes, picked in the options:
//      Tap: a button arms its spell for the next tap only, then taps go back
//        to the default attack. Tap the same button again to disarm it.
//      MOBA: press a button and drag: a band shows where the spell will go,
//        relative to your warlock, and letting go casts it (see aim.js). A
//        quick tap casts at the nearest rival; let go back on the button to
//        cancel.
//    Self-cast spells (Self-Explode…) fire at once in both;
//  - the camera follows the hero at a fixed distance. Once dead, dragging the
//    battlefield or the joystick looks around, and tapping a player (or the
//    arrows of the spectate bar) watches them.

import { unlockAudio } from './audio.js';
import { PHONE } from './device.js';
import { Aim, nearestRival } from './aim.js';

const RESEND_MS = 100;
const AHEAD = 3; // metres ahead of the hero the joystick's move order points
const DEAD = 12; // joystick dead zone, px
const TAP_MOVE = 14; // a touch that moves further than this is a drag, not a tap
const SNAP = 2.5; // metres: a tap this close to a rival targets the rival
const DRAG_FULL = 120; // px of drag that casts a distance spell at full range
const OPTS_KEY = 'touch-controls';

// The player's choices; see the header.
const DEFAULTS = { scheme: 'tap', layout: 'corner', fireball: 'tap' };
const CHOICES = [
  { key: 'scheme', label: 'Spell buttons', values: [['tap', 'Tap, then tap a target'], ['moba', 'MOBA: drag to aim']] },
  { key: 'fireball', label: 'Fireball', values: [['tap', 'Tap anywhere'], ['button', 'Its own button']] },
  { key: 'layout', label: 'Buttons', values: [['corner', 'Bottom-right corner'], ['edge', 'Right edge']] },
];

function loadOpts() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export class Touch {
  constructor({ world, input, send, getMyId, defaultSlot = null }) {
    this.defaultSlot = defaultSlot; // the default attack's slot (no button unless asked for)
    this.world = world;
    this.input = input;
    this.send = send;
    this.getMyId = getMyId;
    this.opts = loadOpts();
    this.aim = new Aim({ world, input });
    this.stick = null; // { id, cx, cy, dx, dy }
    this.moving = false;
    this.lastDir = null;
    this.lastSent = 0;
    this.touches = new Map(); // canvas touches: pointerId -> {x, y, x0, y0, grab}
    this.btn = null; // a MOBA drag from a button: { id, slot, x0, y0, el, out }

    document.body.classList.add('touch');
    document.body.classList.toggle('phone', PHONE);
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

    // Spell buttons fire (or start aiming) on touch-down, not on the later
    // click, and show no tooltip (there is no hover on a phone).
    const card = (this.card = document.getElementById('cmdcard'));
    let cardTouch = 0;
    card.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      const b = e.target.closest('[data-slot]');
      if (!b) return;
      cardTouch = performance.now();
      unlockAudio();
      this.buttonDown(e, b);
    });
    card.addEventListener('pointermove', (e) => this.buttonMove(e));
    card.addEventListener('pointerup', (e) => {
      this.buttonUp(e);
      setTimeout(() => (document.getElementById('tooltip').hidden = true), 0);
    });
    card.addEventListener('pointercancel', (e) => this.buttonUp(e, true));
    card.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    for (const type of ['mousedown', 'click']) {
      card.addEventListener(type, (e) => {
        if (performance.now() - cardTouch < 800) e.stopPropagation(); // the tap's emulated mouse events
      }, true);
    }
    // The HUD rebuilds the buttons when the spells change: lay them out again.
    new MutationObserver(() => this.layout()).observe(card, { childList: true });
    window.addEventListener('resize', () => this.layout());

    // The shop fills a phone's screen: other panels step aside while it is open.
    const shop = document.getElementById('shop');
    new MutationObserver(() => document.body.classList.toggle('shopping', !shop.hidden)).observe(shop, { attributes: true, attributeFilter: ['hidden'] });

    // Tapping the top bar shows or hides the scoreboard.
    document.getElementById('topbar').addEventListener('click', () => document.body.classList.toggle('mb-open'));

    // Phones get the whole screen, in landscape where the browser allows it.
    for (const id of ['create', 'join', 'start']) {
      document.getElementById(id)?.addEventListener('click', () => this.fullscreen());
    }

    this.optionsUi();
    this.applyOpts();
    setInterval(() => this.tick(), RESEND_MS);
    const frame = () => {
      this.aim.frame();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  fullscreen() {
    if (!PHONE) return; // not on touchscreen laptops and desktops
    const d = document.documentElement;
    if (document.fullscreenElement || !d.requestFullscreen) return;
    d.requestFullscreen({ navigationUI: 'hide' })
      .then(() => screen.orientation?.lock?.('landscape'))
      .catch(() => {});
  }

  me() {
    return this.world.myView();
  }

  // After dying, the controls look around instead.
  spectating() {
    return this.world.isDead();
  }

  // ------------------------------------------------------------ options

  optionsUi() {
    const keys = document.querySelector('#options .keys');
    if (!keys) return;
    keys.insertAdjacentHTML('beforebegin', `<div id="touchopts">${CHOICES.map((c) => `
      <div class="optrow"><span>${c.label}</span>${c.values.map(([v, l]) => `<button class="btn small" data-topt="${c.key}" data-val="${v}">${l}</button>`).join('')}</div>`).join('')}</div>`);
    document.getElementById('touchopts').addEventListener('click', (e) => {
      const b = e.target.closest('[data-topt]');
      if (!b) return;
      this.opts[b.dataset.topt] = b.dataset.val;
      try {
        localStorage.setItem(OPTS_KEY, JSON.stringify(this.opts));
      } catch {}
      this.applyOpts();
    });
  }

  applyOpts() {
    for (const b of document.querySelectorAll('[data-topt]')) b.classList.toggle('sel', this.opts[b.dataset.topt] === b.dataset.val);
    const cl = document.body.classList;
    cl.toggle('t-moba', this.opts.scheme === 'moba');
    cl.toggle('t-edge', this.opts.layout === 'edge');
    cl.toggle('t-fbbtn', this.opts.fireball === 'button');
    this.input.cancelTarget();
    this.aim.stop();
    this.layout();
  }

  // Places the spell buttons. Corner: the default attack (a button, or just
  // its cooldown dial) in the corner and the rest on two arcs around it, like
  // a MOBA's. Edge: a column up the right edge (two when it doesn't fit).
  layout() {
    const els = [...this.card.children];
    const fb = this.defaultSlot != null ? els[this.defaultSlot] : null;
    const rest = els.filter((el) => el !== fb && !el.classList.contains('empty'));
    for (const el of els) el.classList.toggle('dial', el === fb && this.opts.fireball !== 'button');
    const fbSize = !fb ? 0 : this.opts.fireball === 'button' ? 76 : 46;
    const S = 58; // a spell button
    const place = (el, right, bottom, size) => {
      el.style.width = el.style.height = `${size}px`;
      el.style.right = `calc(${right - size / 2}px + env(safe-area-inset-right))`;
      el.style.bottom = `${bottom - size / 2}px`;
    };
    const C = 12 + 38; // the corner slot's centre, from the right and bottom edges
    if (fb) place(fb, C, C, fbSize);
    if (this.opts.layout === 'edge') {
      const step = S + 8;
      const perCol = Math.max(1, Math.floor((innerHeight - 56 - (C + 38 + 6)) / step));
      rest.forEach((el, i) => {
        const col = Math.floor(i / perCol);
        const row = i % perCol;
        place(el, 12 + S / 2 + col * step, C + 38 + 6 + S / 2 + row * step, S);
      });
      return;
    }
    // Two arcs, from left of the corner round to above it.
    const arcs = [{ r: 96, n: 3 }, { r: 166, n: 4 }, { r: 236, n: 5 }];
    let i = 0;
    for (const { r, n } of arcs) {
      for (let k = 0; k < n && i < rest.length; k++, i++) {
        const t = n > 1 ? k / (n - 1) : 0.5;
        const a = Math.PI - t * (Math.PI / 2); // 180° (left) to 90° (up)
        place(rest[i], C - r * Math.cos(a), C + r * Math.sin(a), S);
      }
    }
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
    if (dir == null) this.halt(); // back in the middle: stand still
    else if (this.lastDir == null || Math.abs(Math.atan2(Math.sin(dir - this.lastDir), Math.cos(dir - this.lastDir))) > 0.35) this.steer(true);
  }

  stickUp(e) {
    const s = this.stick;
    if (!s || e.pointerId !== s.id) return;
    this.stick = null;
    document.getElementById('joy-knob').style.transform = '';
    this.world.touchPan = null;
    this.halt();
  }

  // Stops the walk: the last order points a few metres ahead.
  halt() {
    this.lastDir = null;
    if (!this.moving) return;
    this.moving = false;
    // Don't cancel a spell that is still turning to face its target.
    const wait = Math.max(0, this.input.holdPause - performance.now());
    setTimeout(() => {
      if (!this.moving) this.send({ t: 'cmd', c: 'stop' });
    }, wait);
  }

  tick() {
    if (this.stick) this.steer(false);
  }

  // Sends a move order a few metres ahead of the hero in the stick's direction.
  steer(now) {
    const s = this.stick;
    if (!s) return;
    if (this.spectating()) {
      const l = Math.hypot(s.dx, s.dy);
      this.world.touchPan = l > DEAD ? { x: s.dx / s.max, z: s.dy / s.max } : null;
      return;
    }
    this.world.touchPan = null;
    if (!this.input.active) return;
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

  // ------------------------------------------------------- spell buttons

  buttonDown(e, b) {
    const slot = +b.dataset.slot;
    if (this.btn) return;
    const moba = this.opts.scheme === 'moba';
    // Aim by dragging from the button: every aimed spell with MOBA controls,
    // and in either scheme the default attack's button (it has nothing to
    // arm: a tap anywhere is it) and drag-or-tap spells (Teleport).
    if (!this.aim.start(slot)) return; // nothing to aim: a self-cast went off, or an error showed
    const a = this.aim.cur.a;
    if (moba || slot === this.defaultSlot || a.tapTarget) {
      const armed = this.input.targeting === a.target; // a plain tap on it again disarms it
      this.input.cancelTarget();
      this.btn = { id: e.pointerId, slot, x0: e.clientX, y0: e.clientY, el: b, out: false, dragged: false, armed };
      try {
        b.setPointerCapture?.(e.pointerId);
      } catch {}
      return;
    }
    this.aim.stop();
    this.input.useSlot(slot); // tap scheme: ready the spell for the next tap
  }

  buttonMove(e) {
    const t = this.btn;
    if (!t || e.pointerId !== t.id) return;
    const dx = e.clientX - t.x0;
    const dy = e.clientY - t.y0;
    const len = Math.hypot(dx, dy);
    if (len > 40) t.out = true;
    if (len > TAP_MOVE) t.dragged = true;
    // Back on the button after dragging off it: letting go there cancels.
    const r = t.el.getBoundingClientRect();
    const over = t.out && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    this.aim.set(len > TAP_MOVE ? dx : 0, len > TAP_MOVE ? dy : 0, Math.min(1, len / DRAG_FULL), over);
  }

  buttonUp(e, cancelled = false) {
    const t = this.btn;
    if (!t || e.pointerId !== t.id) return;
    this.btn = null;
    if (cancelled) return this.aim.stop();
    // A plain tap on a drag-or-tap spell readies it for a tap on the ground.
    if (!t.dragged && this.aim.cur?.a.tapTarget) {
      this.aim.stop();
      if (!t.armed) this.input.useSlot(t.slot);
      return;
    }
    this.aim.release();
  }

  // -------------------------------------------------------------- taps

  down(e) {
    if (e.pointerType === 'mouse') return;
    unlockAudio();
    this.input.lastTouch = performance.now();
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
  }

  move(e) {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    // Spectating: one finger drags the battlefield around.
    if (this.spectating() && this.touches.size === 1) {
      const a = this.world.screenToGround(t.x, t.y);
      const b = this.world.screenToGround(e.clientX, e.clientY);
      if (a && b) this.world.panBy(a.x - b.x, a.y - b.y);
    }
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
    if (this.spectating()) {
      // Tap a player to watch them.
      const v = nearestRival(this.world, this.getMyId(), p.x, p.y, 3);
      if (v) this.world.spectate = v.id;
      return;
    }
    if (input.targeting) {
      input.castAt(input.targeting, this.snap(p));
      input.cancelTarget();
    } else if (this.defaultSlot != null && this.opts.fireball !== 'button') {
      input.castSlotAt(this.defaultSlot, this.snap(p));
    }
  }

  // The nearest living rival within SNAP of the tap, or the tap itself.
  snap(p) {
    const v = nearestRival(this.world, this.getMyId(), p.x, p.y, SNAP);
    return v ? { x: v.x, y: v.z } : p;
  }
}
