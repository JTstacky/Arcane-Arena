// Controller support (XInput / any "standard" gamepad, desktop and phone):
//   left stick   walk (like the touch joystick: a move order a few metres
//                ahead, re-sent while held; centring it stops)
//   right stick  aim; when dead, look around (D-pad left/right watches a player)
//   RT           Fireball · A B X Y LB RB  spells 2–7 · LT  Scourge
//                hold to see where it goes (aim.js), release to cast; with the
//                right stick centred it goes at the nearest rival
//   Start        ready up in the shop, else options · Back  scoreboard
// The camera follows your warlock while a controller is in use.

import { Aim } from './aim.js';
import { unlockAudio } from './audio.js';

const DEAD = 0.25; // stick dead zone
const RESEND_MS = 100;
const AHEAD = 3;
// Standard-mapping button index -> spell slot.
const SLOT_BUTTONS = [[7, 0], [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]];
const START = 9;
const BACK = 8;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;

export class Gamepads {
  constructor({ world, input, send }) {
    this.world = world;
    this.input = input;
    this.send = send;
    this.aim = new Aim({ world, input });
    this.prev = []; // last frame's pressed buttons
    this.held = -1; // the spell button being held to aim
    this.moving = false;
    this.lastSent = 0;
    this.running = false;
    this.last = 0;
    window.addEventListener('gamepadconnected', () => this.run());
    if (navigator.getGamepads?.().some(Boolean)) this.run();
  }

  run() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now) => {
      const pad = [...(navigator.getGamepads?.() || [])].find((p) => p?.connected);
      if (!pad) {
        this.running = false;
        this.aim.stop();
        return;
      }
      this.poll(pad, Math.min(0.1, (now - this.last) / 1000));
      this.last = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  poll(pad, dt) {
    const input = this.input;
    const world = this.world;
    const pressed = pad.buttons.map((b) => b.pressed || b.value > 0.5);
    const down = (i) => pressed[i] && !this.prev[i];
    const stick = (ix, iy) => {
      const x = pad.axes[ix] || 0;
      const y = pad.axes[iy] || 0;
      const m = Math.hypot(x, y);
      return m < DEAD ? { x: 0, y: 0, m: 0 } : { x, y, m: Math.min(1, (m - DEAD) / (1 - DEAD)) };
    };
    const L = stick(0, 1);
    const R = stick(2, 3);
    if (pressed.some(Boolean) || L.m || R.m) {
      unlockAudio();
      if (!this.used) {
        this.used = true; // a controller is in use: follow the warlock
        world.follow = true;
      }
    }

    if (down(START)) {
      const ready = document.getElementById('shop-ready');
      if (ready && !document.getElementById('shop').hidden) ready.click();
      else document.getElementById('options').hidden = !document.getElementById('options').hidden;
    }
    if (down(BACK)) document.body.classList.toggle('mb-open');

    const me = world.myView();
    const dead = world.isDead();
    if (dead) {
      // Spectate: the right stick looks around, the D-pad picks a player.
      if (R.m) world.panBy(R.x * dt * 25, R.y * dt * 25);
      if (down(DPAD_LEFT)) world.spectateNext(-1);
      if (down(DPAD_RIGHT)) world.spectateNext(1);
    } else if (this.used && !world.follow) world.follow = true;

    // Walking.
    if (L.m && input.active && me && !dead) {
      const now = performance.now();
      if (now - this.lastSent >= RESEND_MS && now >= input.holdPause) {
        const a = Math.atan2(L.y, L.x); // screen right is +x, down is +z
        this.send({ t: 'cmd', c: 'move', x: +(me.x + Math.cos(a) * AHEAD).toFixed(2), y: +(me.z + Math.sin(a) * AHEAD).toFixed(2) });
        this.lastSent = now;
        this.moving = true;
      }
    } else if (this.moving) {
      this.moving = false;
      // Don't cancel a spell that is still turning to face its target.
      setTimeout(() => {
        if (!this.moving) this.send({ t: 'cmd', c: 'stop' });
      }, Math.max(0, input.holdPause - performance.now()));
    }

    // Spells: press to aim, release to cast.
    if (this.held >= 0) {
      if (!pressed[this.held]) {
        this.held = -1;
        this.aim.release();
      } else this.aim.set(R.x, R.y, R.m);
    } else {
      for (const [b, slot] of SLOT_BUTTONS) {
        if (!down(b)) continue;
        if (this.aim.start(slot)) {
          this.held = b;
          this.aim.set(R.x, R.y, R.m);
        }
        break;
      }
    }
    this.aim.frame();
    this.prev = pressed;
  }
}
