// Warcraft III controls: right-click to move, hotkey then left-click to cast
// (or quick-cast at the cursor, an option), S to stop, Space to centre the
// camera, screen edges and arrow keys to scroll it.

import { toggleMute, unlockAudio, play } from './audio.js';

// `slots` comes from the game:
//   slotForKey(event) -> slot index or -1
//   action(slot, snap, myId) -> null (nothing) | { error: true } |
//     { send: msg } (fire immediately) | { self: spell } (cast on yourself) |
//     { target: spell, name, range } (cast at a point: quick-cast or targeting)

export class Input {
  constructor({ world, send, getSnap, getMyId, onChatKey, onMenu, onError, slots }) {
    this.onError = onError || (() => {});
    this.world = world;
    this.slots = slots;
    this.send = send;
    this.getSnap = getSnap;
    this.getMyId = getMyId;
    this.onChatKey = onChatKey;
    this.onMenu = onMenu;
    this.active = false;
    this.targeting = null; // spell id or 'shove'
    this.mouse = { x: innerWidth / 2, y: innerHeight / 2 };
    this.rightHeld = false;
    this.holdPause = 0;
    this.keysDown = new Set();
    this.quickCast = true;
    const canvas = world.canvas;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => this.mouseDown(e));
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.rightHeld = false;
    });
    window.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      world.zoom = Math.max(20, Math.min(45, world.zoom + Math.sign(e.deltaY) * 2));
    }, { passive: false });
    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => this.keysDown.delete(e.code));
    // Holding right-click keeps re-issuing the move order (modern QoL).
    setInterval(() => {
      // Don't let held right-click cancel a spell during its cast point.
      if (this.active && this.rightHeld && performance.now() > this.holdPause) this.moveToCursor(false);
    }, 120);
  }

  ground() {
    return this.world.screenToGround(this.mouse.x, this.mouse.y);
  }

  moveToCursor(marker = true) {
    const p = this.ground();
    if (!p) return;
    this.send({ t: 'cmd', c: 'move', x: +p.x.toFixed(2), y: +p.y.toFixed(2) });
    if (marker) this.world.moveMarker(p.x, p.y);
  }

  mouseDown(e) {
    unlockAudio();
    if (!this.active) return;
    // Browsers follow a tap with emulated mouse events; the touch code has
    // already handled it.
    if (performance.now() - (this.lastTouch || 0) < 800) return;
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    if (e.button === 2) {
      if (this.targeting) return this.cancelTarget();
      this.rightHeld = true;
      this.moveToCursor();
    } else if (e.button === 0 && this.targeting) {
      const p = this.ground();
      if (p) this.castAt(this.targeting, p);
      this.cancelTarget();
    }
  }

  castAt(spell, p, marker = true) {
    this.holdPause = performance.now() + 450;
    this.send({ t: 'cmd', c: 'cast', spell, x: +p.x.toFixed(2), y: +p.y.toFixed(2) });
    if (marker) this.world.moveMarker(p.x, p.y);
  }

  // Called for hotkeys and command-card clicks.
  useSlot(i) {
    unlockAudio();
    const snap = this.getSnap();
    if (!snap || !this.active) return;
    const a = this.slots.action(i, snap, this.getMyId());
    if (!a) return;
    // On touch, tapping the selected spell again cancels it.
    if (this.touchMode && this.targeting && this.targeting === a.target) return this.cancelTarget();
    if (a.error) {
      play('error');
      return this.onError('Spell is not ready yet.');
    }
    if (a.send) return this.send(a.send);
    if (a.self) {
      const unit = this.world.myView();
      this.castAt(a.self, unit ? { x: unit.x, y: unit.z } : { x: 0, y: 0 }, false);
      // During a wind-up (Scourge) orders are queued on the server, so held
      // right-click and the joystick hold off rather than stack them up.
      if (a.hold) this.holdPause = performance.now() + 450 + a.hold * 1000;
      return;
    }
    if (this.quickCast) {
      const p = this.ground();
      if (p) this.castAt(a.target, p);
      return;
    }
    this.targeting = a.target;
    document.body.classList.add('targeting');
    document.body.dataset.armed = i; // highlights the button (touch)
    const hint = document.getElementById('targethint');
    hint.hidden = false;
    hint.textContent = this.touchMode ? `${a.name}: tap where to cast it (tap the button again to cancel)` : `${a.name}: left-click a target (right-click to cancel)`;
    this.range = a.range ?? null;
    this.aoe = a.aoe ?? 1.5;
  }

  // Casts the spell in slot `i` at point `p` straight away (the touch
  // controls' default attack).
  castSlotAt(i, p) {
    unlockAudio();
    const snap = this.getSnap();
    if (!snap || !this.active) return;
    const a = this.slots.action(i, snap, this.getMyId());
    if (!a) return;
    if (a.error) {
      play('error');
      return this.onError('Spell is not ready yet.');
    }
    if (a.send) return this.send(a.send);
    if (a.target) this.castAt(a.target, p);
  }

  cancelTarget() {
    this.targeting = null;
    this.range = null;
    document.body.classList.remove('targeting');
    delete document.body.dataset.armed;
    document.getElementById('targethint').hidden = true;
    this.world.showRange(null);
    this.world.showReticle(null);
  }

  keyDown(e) {
    const typing = document.activeElement?.tagName === 'INPUT';
    if (e.key === 'Enter') {
      this.onChatKey();
      e.preventDefault();
      return;
    }
    if (typing) return;
    if (e.code === 'Escape') {
      if (this.targeting) this.cancelTarget();
      else this.onMenu();
      return;
    }
    if (e.code === 'F8') {
      e.preventDefault();
      this.world.toggleLab();
      return;
    }
    if (e.code === 'KeyM') {
      toggleMute();
      const cb = document.getElementById('opt-mute');
      if (cb) cb.checked = !cb.checked;
      return;
    }
    if (!this.active) return;
    this.keysDown.add(e.code);
    const slot = this.slots.slotForKey(e);
    if (slot >= 0 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.useSlot(slot);
      return;
    }
    if (e.code === 'KeyS') {
      this.send({ t: 'cmd', c: 'stop' });
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      // Dead: Space watches the next living player instead.
      if (this.world.isDead()) this.world.spectateNext(e.shiftKey ? -1 : 1);
      else {
        this.world.follow = true;
        this.world.centerOnMe();
      }
      return;
    }
    if (e.code === 'KeyY') {
      this.world.follow = !this.world.follow;
      return;
    }
    if (e.code === 'Tab') e.preventDefault();
  }

  // Per-frame: edge/arrow-key panning when the camera isn't locked, and the
  // range indicator while targeting.
  frame() {
    const w = this.world;
    let px = 0;
    let pz = 0;
    if (this.keysDown.has('ArrowLeft')) px -= 1;
    if (this.keysDown.has('ArrowRight')) px += 1;
    if (this.keysDown.has('ArrowUp')) pz -= 1;
    if (this.keysDown.has('ArrowDown')) pz += 1;
    // Edge scrolling when the camera is free — including after you die.
    if ((!w.follow || w.isDead()) && !this.touchMode && document.hasFocus()) {
      const m = 6;
      if (this.mouse.x < m) px -= 1;
      if (this.mouse.x > innerWidth - m) px += 1;
      if (this.mouse.y < m) pz -= 1;
      if (this.mouse.y > innerHeight - m) pz += 1;
    }
    if ((px || pz) && !w.isDead()) w.follow = false;
    w.pan = px || pz ? { x: px, z: pz } : null;
    if (this.targeting) {
      w.showRange(this.range);
      if (!this.touchMode) w.showReticle(this.ground(), this.aoe);
    }
  }
}
