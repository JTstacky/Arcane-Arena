// Missile visuals, built the way Warcraft III missile models are: a glowing
// head (billboard sprites), a ribbon streak behind it, particles shed along
// the path and a light. Particles are emitted per distance travelled, not per
// frame, so trails stay continuous however fast the missile flies or however
// the frame rate varies.

import * as THREE from 'three';
import { artTexture, Ribbon } from './effects.js';

const HEIGHT = 1.1; // flying height of missiles, in metres
const VORTEX = new THREE.Color('#b36bff');
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const j = () => (Math.random() - 0.5) * 0.25; // a little scatter

function sprite(map, color, size, opacity = 1, gain = 1) {
  const c = new THREE.Color(color).multiplyScalar(gain);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, color: c, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity, toneMapped: false }));
  s.scale.setScalar(size);
  s.renderOrder = 10;
  return s;
}

// Per spell: head sprites, ribbon, and what is shed every `step` metres.
const KINDS = {
  fireball: { head: [['fx_flame', '#ffffff', 1.9, 'spin'], ['fx_flare', '#ffa040', 2.8]], ribbon: { color: '#ff8a2a', width: 1.2, life: 0.22 }, core: { color: '#ffe8b0', width: 0.45, life: 0.12 }, light: ['#ff7a1a', 10, 8], step: 0.3, shed: 'fire' },
  homing: { head: [['fx_wisp', '#6ab0ff', 2.2, 'aim'], ['fx_flare', '#2a70ff', 2.6, null, 0.7]], ribbon: { color: '#3a80ff', width: 0.7, life: 0.4 }, light: ['#6ab8ff', 5, 6], step: 0.4, shed: 'glow' },
  boomerang: { head: [['fx_flare', '#ffc830', 2.2, null, 0.75]], mesh: 'blade', ribbon: { color: '#ffd84d', width: 0.6, life: 0.3 }, light: ['#ffd84d', 4, 5], step: 0.5, shed: 'spark' },
  bouncer: { head: [['fx_orb', '#6dff5a', 1.3, 'spin'], ['fx_flare', '#4dff3a', 2.6, null, 0.7]], ribbon: { color: '#4dff3a', width: 0.8, life: 0.3 }, light: ['#6dff5a', 5, 6], step: 0.4, shed: 'glow' },
  drain: { head: [['fx_orb', '#ff2a3a', 1.2, 'spin'], ['fx_flare', '#d0102a', 2.4, null, 0.8]], ribbon: { color: '#d0102a', width: 0.6, life: 0.35 }, light: ['#ff2030', 4, 5], step: 0.4, shed: 'drip' },
  link: { head: [['fx_orb', '#8affd8', 1.2, 'spin'], ['fx_flare', '#20e8b0', 2.4, null, 0.7]], ribbon: { color: '#4affc8', width: 0.5, life: 0.3 }, light: ['#8affd8', 4, 5], step: 0.35, shed: 'spark' },
  swap: { head: [['fx_orb', '#ff90f0', 1.1, 'spin'], ['fx_flare', '#e040d8', 2.2, null, 0.7]], ribbon: { color: '#e040d8', width: 0.7, life: 0.18 }, light: ['#ff9cf4', 4, 5], step: 0.6, shed: 'glow' },
  gravity: { head: [['fx_orb', '#b36bff', 2.2, 'spin-fast'], ['fx_flare', '#6a20c0', 3.4]], mesh: 'core', light: ['#9a50ff', 5, 7], step: 0.25, shed: 'vortex' },
};

let bladeGeo = null;

export class Missile {
  constructor(fx, kind, color) {
    this.fx = fx;
    this.kind = kind;
    this.def = KINDS[kind] || { head: [['fx_flare', color, 2]], ribbon: { color, width: 0.5, life: 0.25 }, step: 0.5, shed: 'glow' };
    this.color = color;
    this.obj = new THREE.Group();
    this.obj.position.y = HEIGHT;
    this.sprites = [];
    for (const [tex, c, size, mode, opacity = 1] of this.def.head) {
      // Additive heads stack with the ribbon and light, so all but fire are
      // drawn a little darker to keep their hue instead of clipping to white.
      const s = sprite(artTexture(tex), c, size, opacity, kind === 'fireball' ? 1 : 0.7);
      s.userData.mode = mode;
      s.userData.size = size;
      this.sprites.push(s);
      this.obj.add(s);
    }
    if (this.def.mesh === 'blade') {
      bladeGeo = bladeGeo || new THREE.TorusGeometry(0.42, 0.09, 6, 16, Math.PI * 1.25);
      const blade = new THREE.Mesh(bladeGeo, new THREE.MeshStandardMaterial({ color: '#ffe070', emissive: '#aa7a10', metalness: 0.8, roughness: 0.3 }));
      blade.rotation.x = Math.PI / 2;
      this.spin = blade;
      this.obj.add(blade);
    } else if (this.def.mesh === 'core') {
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), new THREE.MeshBasicMaterial({ color: '#07000e' }));
      core.renderOrder = 11;
      this.obj.add(core);
    }
    if (this.def.light) {
      // A light from the shared pool (null when all are in use).
      const [c, , d] = this.def.light;
      this.light = fx.borrowLight(c, d);
      this.light?.position.set(0, -100, 0);
    }
    this.ribbon = this.def.ribbon ? new Ribbon(fx, this.def.ribbon) : null;
    this.core = this.def.core ? new Ribbon(fx, this.def.core) : null; // a bright inner streak
    this.last = { x: 0, z: 0 };
    this.hasLast = false;
    this.dir = { x: 0, z: 0 };
    this.hasDir = false;
    this.acc = 0;
    this.t = Math.random() * 10;
  }

  // Moves the missile to (x, z) for this frame.
  update(x, z, dt, visible) {
    this.t += dt;
    const o = this.obj;
    if (!visible) return;
    const prev = this.hasLast ? this.last : null;
    o.position.x = x;
    o.position.z = z;
    let dx = 0;
    let dz = 0;
    if (prev) {
      dx = x - prev.x;
      dz = z - prev.z;
    }
    const moved = Math.hypot(dx, dz);
    if (moved > 1e-4) {
      this.dir.x = dx / moved;
      this.dir.z = dz / moved;
      this.hasDir = true;
    }
    for (const s of this.sprites) {
      const m = s.userData.mode;
      if (m === 'spin') s.material.rotation += dt * 4;
      else if (m === 'spin-fast') s.material.rotation -= dt * 9;
      else if (m === 'aim' && this.hasDir) s.material.rotation = this.screenAngle();
      const pulse = 1 + Math.sin(this.t * 18 + s.userData.size) * 0.06;
      s.scale.setScalar(s.userData.size * pulse);
    }
    if (this.spin) this.spin.rotation.z += dt * 22;
    if (this.light) {
      this.light.position.set(x, HEIGHT, z);
      this.light.intensity = this.def.light[1] * (0.85 + Math.random() * 0.3);
    }
    this.ribbon?.push(x, HEIGHT, z);
    this.core?.push(x, HEIGHT, z);

    // Shed particles evenly along the path travelled this frame.
    if (prev && moved < 8) {
      this.acc += moved;
      const step = this.def.step;
      while (this.acc >= step) {
        this.acc -= step;
        const k = 1 - this.acc / Math.max(moved, 1e-6);
        this.shed(prev.x + dx * k, prev.z + dz * k);
      }
    } else if (!prev) this.shed(x, z);
    this.last.x = x;
    this.last.z = z;
    this.hasLast = true;
  }

  // The missile's travel direction as an angle on screen, for sprites that
  // point along the flight path.
  screenAngle() {
    const cam = this.fx.camera;
    const p = this.obj.position;
    const a = _a.set(p.x, HEIGHT, p.z).project(cam);
    const b = _b.set(p.x + this.dir.x, HEIGHT, p.z + this.dir.z).project(cam);
    return Math.atan2(b.y - a.y, (b.x - a.x) * (cam.aspect || 1));
  }

  shed(x, z) {
    const fx = this.fx;
    const d = this.dir;
    switch (this.def.shed) {
      case 'fire':
        fx.fire(x + j(), HEIGHT + j(), z + j(), 1.1 + Math.random() * 0.5, 0.32 + Math.random() * 0.15, { vx: -d.x * 1.5, vy: 0.6, vz: -d.z * 1.5 });
        if (Math.random() < 0.35) fx.spark(x, HEIGHT, z, '#ffb040', 0.5, 0.5, 1.5);
        break;
      case 'glow':
        fx.trail(x + j(), HEIGHT + j(), z + j(), this.color, 0.55, 0.4, 0.1);
        break;
      case 'spark':
        fx.spark(x, HEIGHT, z, this.color, 0.55, 0.35, 1.2);
        fx.trail(x, HEIGHT, z, this.color, 0.4, 0.25, 0.1);
        break;
      case 'drip':
        fx.trail(x + j(), HEIGHT + j(), z + j(), '#d0102a', 0.5, 0.45, 0.1);
        if (Math.random() < 0.4) fx.spark(x, HEIGHT - 0.1, z, '#ff3040', 0.5, 0.5, 0.6);
        break;
      case 'vortex':
        for (let i = 0; i < 2; i++) {
          const a = Math.random() * Math.PI * 2;
          const r = 1.2 + Math.random() * 2.2;
          fx.add.spawn(x + Math.cos(a) * r, HEIGHT - 0.3 + Math.random() * 0.6, z + Math.sin(a) * r, (-Math.cos(a) + Math.sin(a) * 0.8) * r * 2.2, 0, (-Math.sin(a) - Math.cos(a) * 0.8) * r * 2.2, VORTEX, 0.7, 0.45, 0, 0);
        }
        break;
    }
  }

  // The missile is gone: its streak fades out quickly behind it.
  release() {
    this.fx.returnLight(this.light);
    this.light = null;
    this.ribbon?.release(0.12);
    this.core?.release(0.08);
  }
}
