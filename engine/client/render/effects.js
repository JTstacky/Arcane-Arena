// Visual effects in the manner of Warcraft III's model emitters:
//  - textured, camera-facing particles (flipbook fire, glows, sparks and
//    smoke) in pooled GPU systems;
//  - ribbon trails, the streaks behind missiles;
//  - textured beams for lightning and chains;
//  - expanding shockwave rings, flashes of light and floating text.
// Textures are painted sprites on black (drawn additively) from art/. Until
// one has loaded, a procedural stand-in is used.

import * as THREE from 'three';
import { LOW } from '../device.js';

// ------------------------------------------------------------ textures

const ART = './art/';
const texCache = new Map();

function canvasTex(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function softDot(g, s) {
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, '#fff');
  grd.addColorStop(0.12, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  grd.addColorStop(0.7, 'rgba(255,255,255,0.08)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = '#000';
  g.fillRect(0, 0, s, s);
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
}

// Loads art/<name>.webp into a texture that shows `fallback` until then.
// `raw` textures skip colour management, for custom shaders that output
// colours as they are (three's own materials want sRGB-tagged textures).
export function artTexture(name, fallback = softDot, { repeat = false, raw = false } = {}) {
  const key = `${name}|${raw}`;
  if (texCache.has(key)) return texCache.get(key);
  const tex = canvasTex(64, fallback);
  if (raw) tex.colorSpace = THREE.NoColorSpace;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  new THREE.ImageLoader().load(`${ART}${name}.webp`, (img) => {
    tex.image = img;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
  });
  texCache.set(key, tex);
  return tex;
}

// A streak that is bright at the head and fades toward the tail (u) and
// toward the edges (v), for ribbons.
function streakTex() {
  if (texCache.has('streak')) return texCache.get('streak');
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 32;
  const g = c.getContext('2d');
  const img = g.createImageData(128, 32);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 128; x++) {
      const u = x / 127;
      const v = Math.abs(y / 31 - 0.5) * 2;
      const a = Math.pow(1 - u, 1.4) * Math.pow(Math.max(0, 1 - v * v), 1.5);
      const i = (y * 128 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255 * a;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set('streak', t);
  return t;
}

// ------------------------------------------------------------ particles

const vert = /* glsl */ `
  attribute float size;
  attribute float alpha;
  attribute float frame;
  attribute float rot;
  attribute vec3 color;
  varying float vAlpha;
  varying float vFrame;
  varying float vRot;
  varying vec3 vColor;
  uniform float scale;
  void main() {
    vAlpha = alpha;
    vColor = color;
    vFrame = frame;
    vRot = rot;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = alpha > 0.0 ? size * scale / -mv.z : 0.0;
    gl_Position = projectionMatrix * mv;
  }
`;
const frag = /* glsl */ `
  uniform sampler2D map;
  uniform vec2 grid;
  uniform float lumAlpha;
  varying float vAlpha;
  varying float vFrame;
  varying float vRot;
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float c = cos(vRot), s = sin(vRot);
    p = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5;
    if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) discard;
    float col = mod(vFrame, grid.x);
    float row = floor(vFrame / grid.x);
    vec2 uv = vec2((col + p.x) / grid.x, 1.0 - (row + p.y) / grid.y);
    vec4 t = texture2D(map, uv);
    if (lumAlpha > 0.5) {
      float a = max(t.r, max(t.g, t.b));
      gl_FragColor = vec4(vColor * (0.55 + 0.45 * t.rgb / max(a, 0.001)), a * vAlpha);
    } else {
      gl_FragColor = vec4(t.rgb * vColor * vAlpha, 1.0);
    }
  }
`;

const srgb = new THREE.Color();

class Particles {
  // `grid` [cols, rows] makes the texture a flipbook played over each
  // particle's life. `lumAlpha` draws a black-background sprite with normal
  // blending, taking alpha from brightness (for smoke).
  constructor(scene, { map, grid = [1, 1], additive = true, lumAlpha = false, max = 3000, order = 10 }) {
    this.max = max = LOW ? Math.ceil(max * 0.35) : max;
    this.frames = grid[0] * grid[1];
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.frame = new Float32Array(max);
    this.rot = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.endScale = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.spin = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.next = 0;
    this.live = 0;
    const geo = new THREE.BufferGeometry();
    const attr = (a, n) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr(this.pos, 3));
    geo.setAttribute('color', attr(this.col, 3));
    geo.setAttribute('size', attr(this.size, 1));
    geo.setAttribute('alpha', attr(this.alpha, 1));
    geo.setAttribute('frame', attr(this.frame, 1));
    geo.setAttribute('rot', attr(this.rot, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { scale: { value: 400 }, map: { value: map }, grid: { value: new THREE.Vector2(grid[0], grid[1]) }, lumAlpha: { value: lumAlpha ? 1 : 0 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.CustomBlending : THREE.NormalBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    if (!additive) this.material.blending = THREE.NormalBlending;
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = order;
    scene.add(this.points);
    this.geo = geo;
  }

  spawn(x, y, z, vx, vy, vz, color, size, life, grav = 0, drag = 0, { endScale = 0.4, spin = 0, alpha = 1, rot = Math.random() * 6.283 } = {}) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    // The shader outputs colours as they are, so store them in sRGB.
    const c = srgb.copy(color).convertLinearToSRGB();
    this.col[i * 3] = c.r;
    this.col[i * 3 + 1] = c.g;
    this.col[i * 3 + 2] = c.b;
    this.size[i] = this.size0[i] = size;
    this.endScale[i] = endScale;
    this.life[i] = this.maxLife[i] = life;
    this.grav[i] = grav;
    this.drag[i] = drag;
    this.spin[i] = spin;
    this.rot[i] = rot;
    this.frame[i] = 0;
    this.alpha[i] = this.a0[i] = alpha;
    this.live = Math.max(this.live, 1);
  }

  update(dt) {
    if (!this.live) return;
    let live = 0;
    const F = this.frames;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) this.alpha[i] = 0;
        continue;
      }
      live++;
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]); // 1 at birth, 0 at death
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= dr;
      this.vel[i * 3 + 2] *= dr;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * dr - this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.rot[i] += this.spin[i] * dt;
      if (F > 1) {
        // The flipbook carries its own fade, so only the last bit fades out.
        this.frame[i] = Math.min(F - 1, Math.floor((1 - k) * F));
        this.alpha[i] = this.a0[i] * Math.min(1, k * 4);
      } else {
        this.alpha[i] = this.a0[i] * k;
      }
      this.size[i] = this.size0[i] * (this.endScale[i] + (1 - this.endScale[i]) * k);
    }
    this.live = live;
    for (const a of ['position', 'color', 'size', 'alpha', 'frame', 'rot']) this.geo.attributes[a].needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
    this.geo.attributes.alpha.needsUpdate = true;
  }
}

// ------------------------------------------------------------ ribbons

const _v = new THREE.Vector3();
const _t = new THREE.Vector3();
const _c = new THREE.Vector3();

// A ribbon trail (WC3's ribbon emitter): the path of its head over the last
// `life` seconds, drawn as a camera-facing strip that narrows and fades
// toward the tail.
export class Ribbon {
  constructor(fx, { color = '#fff', width = 0.5, life = 0.25, map = null, opacity = 1, maxPoints = 48 }) {
    this.fx = fx;
    this.width = width;
    this.life = life;
    this.maxPoints = maxPoints;
    this.pts = [];
    this.time = 0;
    this.dead = false;
    const geo = new THREE.BufferGeometry();
    this.posArr = new Float32Array(maxPoints * 2 * 3);
    this.uvArr = new Float32Array(maxPoints * 2 * 2);
    const idx = [];
    for (let i = 0; i < maxPoints - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    geo.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uvArr, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.mat = new THREE.MeshBasicMaterial({ map: map || streakTex(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    fx.scene.add(this.mesh);
    this.geo = geo;
    fx.ribbons.add(this);
  }

  // Adds the head position for this frame.
  push(x, y, z) {
    const last = this.pts[this.pts.length - 1];
    if (last && Math.hypot(last.x - x, last.y - y, last.z - z) < 0.04) {
      last.x = x;
      last.y = y;
      last.z = z;
      last.t = this.time;
      return;
    }
    this.pts.push({ x, y, z, t: this.time });
    if (this.pts.length > this.maxPoints) this.pts.shift();
  }

  // Stops following; the trail fades out over `fade` seconds.
  release(fade = this.life) {
    this.dead = true;
    this.fadeLeft = this.fadeTotal = Math.max(0.01, fade);
  }

  update(dt, camera) {
    this.time += dt;
    const pts = (this.pts = this.pts.filter((p) => this.time - p.t < this.life));
    if (this.dead) {
      this.fadeLeft -= dt;
      this.mat.opacity = Math.max(0, this.fadeLeft / this.fadeTotal);
      if (this.fadeLeft <= 0 || pts.length < 2) return false;
    }
    const n = pts.length;
    if (n < 2) {
      this.geo.setDrawRange(0, 0);
      return true;
    }
    const cam = camera.position;
    for (let i = 0; i < n; i++) {
      const p = pts[n - 1 - i]; // head first
      const q = pts[Math.max(0, n - 2 - i)];
      const r = pts[Math.min(n - 1, n - i)];
      _t.set(r.x - q.x, r.y - q.y, r.z - q.z).normalize();
      _c.set(cam.x - p.x, cam.y - p.y, cam.z - p.z);
      _v.crossVectors(_t, _c).normalize();
      const age = (this.time - p.t) / this.life;
      const w = this.width * 0.5 * (1 - age * 0.7);
      this.posArr.set([p.x + _v.x * w, p.y + _v.y * w, p.z + _v.z * w, p.x - _v.x * w, p.y - _v.y * w, p.z - _v.z * w], i * 6);
      this.uvArr.set([age, 0, age, 1], i * 4);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.uv.needsUpdate = true;
    this.geo.setDrawRange(0, (n - 1) * 6);
    return true;
  }

  dispose() {
    this.fx.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ------------------------------------------------------------ effects

const tmpColor = new THREE.Color();

export class Effects {
  constructor(scene, overlay, camera) {
    this.scene = scene;
    this.overlay = overlay;
    this.camera = camera;
    const raw = { raw: true };
    // Soft glows: the general-purpose additive system.
    const glow = canvasTex(128, softDot);
    glow.colorSpace = THREE.NoColorSpace;
    this.add = new Particles(scene, { map: glow, max: 5000 });
    this.fireSys = new Particles(scene, { map: artTexture('fx_fire_sheet', softDot, raw), grid: [4, 4], max: 2500, order: 11 });
    this.flameSys = new Particles(scene, { map: artTexture('fx_flame', softDot, raw), max: 2500, order: 11 });
    this.sparkSys = new Particles(scene, { map: artTexture('fx_spark', softDot, raw), max: 1500, order: 12 });
    this.norm = new Particles(scene, { map: artTexture('fx_smoke', softDot, raw), additive: false, lumAlpha: true, max: 1500, order: 8 });
    this.systems = [this.add, this.fireSys, this.flameSys, this.sparkSys, this.norm];
    this.transients = [];
    this.ribbons = new Set();
    this.texts = [];
    this.ringTex = artTexture('fx_ring');
    this.ringGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.lightningTex = artTexture('fx_lightning', (g, s) => {
      g.fillStyle = '#000';
      g.fillRect(0, 0, s, s);
      const grd = g.createLinearGradient(0, 0, 0, s);
      grd.addColorStop(0.3, 'rgba(0,0,0,0)');
      grd.addColorStop(0.5, '#fff');
      grd.addColorStop(0.7, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, s, s);
    }, { repeat: true });
  }

  // Point sprites are sized in world units: pixels per unit at depth 1 is
  // the drawing height over 2·tan(fov/2).
  setScale(h) {
    const k = h / (2 * Math.tan(((this.camera.fov || 50) * Math.PI) / 360));
    for (const s of this.systems) s.material.uniforms.scale.value = k;
  }

  // ---- particle helpers (x, z are world coords; y is height)

  burst(x, y, z, color, { n = 20, speed = 4, size = 0.6, life = 0.6, up: upK = 1, grav = 4, additive = true, drag = 1.5 } = {}) {
    const sys = additive ? this.sparkSys : this.norm;
    const c = tmpColor.set(color);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      sys.spawn(x, y, z, Math.cos(a) * s, (Math.random() * 0.8 + 0.2) * upK * speed, Math.sin(a) * s, c, size * (0.8 + Math.random() * 0.9), life * (0.6 + Math.random() * 0.6), grav, drag, { spin: (Math.random() - 0.5) * 6 });
    }
  }

  // A soft glow puff.
  trail(x, y, z, color, size = 0.5, life = 0.35, jitter = 0.15) {
    this.add.spawn(
      x + (Math.random() - 0.5) * jitter, y + (Math.random() - 0.5) * jitter, z + (Math.random() - 0.5) * jitter,
      (Math.random() - 0.5) * 0.6, Math.random() * 0.6, (Math.random() - 0.5) * 0.6,
      tmpColor.set(color), size * 1.6, life, -0.5, 0,
    );
  }

  // One animated puff of fire (flipbook), optionally tinted.
  fire(x, y, z, size = 1, life = 0.6, { vx = 0, vy = 0.8, vz = 0, color = '#ffffff', flip = true } = {}) {
    const sys = flip ? this.fireSys : this.flameSys;
    sys.spawn(x, y, z, vx, vy, vz, tmpColor.set(color), size, life, -0.6, 1.2, { endScale: flip ? 1.25 : 0.3, spin: (Math.random() - 0.5) * 1.5 });
  }

  spark(x, y, z, color, size = 0.6, life = 0.4, speed = 3) {
    const a = Math.random() * Math.PI * 2;
    const e = Math.random() * 1.2;
    this.sparkSys.spawn(x, y, z, Math.cos(a) * speed * Math.cos(e), Math.sin(e) * speed, Math.sin(a) * speed * Math.cos(e), tmpColor.set(color), size, life, 6, 1, { endScale: 0.2 });
  }

  smoke(x, y, z, color = '#444', size = 1.2, life = 1.2) {
    this.norm.spawn(x + (Math.random() - 0.5) * 0.5, y, z + (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5, 0.6 + Math.random() * 0.8, (Math.random() - 0.5) * 0.5, tmpColor.set(color), size, life, -0.2, 0.8, { endScale: 2.2, alpha: 0.75, spin: (Math.random() - 0.5) * 0.8 });
  }

  // A fiery explosion: flipbook fireballs, embers, smoke and a shockwave.
  explosion(x, z, { size = 1, color = null, y = 0.8 } = {}) {
    const tint = color || '#ffffff';
    const n = Math.round(6 + size * 6);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.6 * size;
      const s = (1.2 + Math.random() * 2) * size;
      this.fire(x + Math.cos(a) * r, y + Math.random() * 0.4 * size, z + Math.sin(a) * r, (1.4 + Math.random() * 1.2) * size, 0.5 + Math.random() * 0.4, { vx: Math.cos(a) * s, vy: 0.5 + Math.random() * 1.5 * size, vz: Math.sin(a) * s, color: tint });
    }
    for (let i = 0; i < 6 + size * 8; i++) this.spark(x, y, z, color || '#ffc060', 0.7 * Math.sqrt(size), 0.5 + Math.random() * 0.4, 5 * size);
    for (let i = 0; i < 2 + size * 3; i++) this.smoke(x, y + 0.3, z, '#2e2622', 1.3 * size, 1.4);
    this.add.spawn(x, y, z, 0, 0, 0, tmpColor.set(color || '#ffb050'), 4 * size, 0.25, 0, 0, { endScale: 1.4 });
    this.ring(x, z, 1.4 * size, color || '#ffa040', 0.4);
  }

  // A burst of coloured magic: glows, sparks and a ring.
  magicBurst(x, y, z, color, size = 1) {
    const c = tmpColor.set(color);
    this.add.spawn(x, y, z, 0, 0, 0, c, 4.5 * size, 0.35, 0, 0, { endScale: 1.6, alpha: 0.7 });
    this.add.spawn(x, y, z, 0, 0, 0, tmpColor.set('#ffffff'), 1.1 * size, 0.18, 0, 0, { endScale: 1.2, alpha: 0.6 });
    for (let i = 0; i < 14 * size; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (1.5 + Math.random() * 3) * size;
      this.add.spawn(x, y, z, Math.cos(a) * s, (Math.random() - 0.2) * s, Math.sin(a) * s, tmpColor.set(color), (1 + Math.random() * 0.9) * size, 0.45 + Math.random() * 0.35, 0, 2.5, { alpha: 0.45 });
    }
    for (let i = 0; i < 10 * size; i++) this.spark(x, y, z, color, 0.7, 0.5, 5 * size);
  }

  ring(x, z, radius, color, dur = 0.45, y = 0.08) {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ map: this.ringTex, color, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    m.position.set(x, y, z);
    m.scale.setScalar(0.1);
    m.renderOrder = 7;
    this.scene.add(m);
    this.transients.push({ obj: m, t: 0, dur, update: (k) => { m.scale.setScalar(0.1 + radius * Math.sqrt(k)); m.material.opacity = 1 - k; } });
  }

  flash(x, z, radius, color, dur = 0.3) {
    if (LOW) return; // each extra light recompiles shaders; too costly on phones
    const light = new THREE.PointLight(color, 40, radius * 5, 2);
    light.position.set(x, 1.5, z);
    this.scene.add(light);
    this.transients.push({ obj: light, t: 0, dur, update: (k) => (light.intensity = 40 * (1 - k)) });
  }

  // A textured beam between two points that always faces the camera.
  // Returns a handle whose set(x1, y1, z1, x2, y2, z2) moves it.
  beam({ color = '#bfe6ff', width = 1, map = this.lightningTex, opacity = 1, scroll = 0 } = {}) {
    const mat = new THREE.MeshBasicMaterial({ map: map.clone(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    mat.map.wrapS = THREE.RepeatWrapping;
    mat.map.needsUpdate = true;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 9;
    this.scene.add(mesh);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const handle = {
      mesh,
      mat,
      set: (x1, y1, z1, x2, y2, z2) => {
        a.set(x1, y1, z1);
        b.set(x2, y2, z2);
        const len = a.distanceTo(b) || 0.001;
        mesh.position.copy(a).add(b).multiplyScalar(0.5);
        _t.copy(b).sub(a).normalize();
        _c.copy(this.camera.position).sub(mesh.position);
        _v.crossVectors(_t, _c).normalize();
        const n = new THREE.Vector3().crossVectors(_t, _v);
        mesh.matrix.makeBasis(_t, _v, n);
        mesh.quaternion.setFromRotationMatrix(mesh.matrix);
        mesh.scale.set(len, width, 1);
        mat.map.repeat.set(Math.max(1, len / (width * 3)), 1);
      },
      scroll: (dt) => (mat.map.offset.x -= dt * scroll),
      dispose: () => {
        this.scene.remove(mesh);
        geo.dispose();
        mat.map.dispose();
        mat.dispose();
      },
    };
    return handle;
  }

  // A lightning strike from (x1, z1) to (x2, z2) that flickers and fades.
  bolt(x1, z1, x2, z2, color = '#bfe6ff', dur = 0.5) {
    const main = this.beam({ color, width: 2.6 });
    const core = this.beam({ color: '#ffffff', width: 1.2 });
    const set = () => {
      main.set(x1, 1.2, z1, x2, 1.2, z2);
      core.set(x1, 1.2, z1, x2, 1.2, z2);
      main.mat.map.offset.x = Math.random();
      core.mat.map.offset.x = Math.random();
    };
    set();
    let flick = 0;
    this.transients.push({
      obj: main.mesh, t: 0, dur,
      update: (k) => {
        flick += 1;
        if (flick % 3 === 0) set();
        const o = (1 - k) * (0.7 + Math.random() * 0.3);
        main.mat.opacity = o;
        core.mat.opacity = o;
      },
      dispose: () => {
        main.dispose();
        core.dispose();
      },
    });
    const n = Math.max(4, Math.floor(Math.hypot(x2 - x1, z2 - z1)));
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      if (Math.random() < 0.5) this.spark(x1 + (x2 - x1) * k, 1.2, z1 + (z2 - z1) * k, color, 0.6, 0.35, 2);
    }
    this.magicBurst(x2, 1.2, z2, color, 0.8);
  }

  // Floating text anchored at a world position (WC3's "texttag").
  text(x, y, z, str, color = '#fff', big = false) {
    const el = document.createElement('div');
    el.className = 'ftext' + (big ? ' big' : '');
    el.textContent = str;
    el.style.color = color;
    this.overlay.appendChild(el);
    this.texts.push({ el, pos: new THREE.Vector3(x, y, z), t: 0, dur: big ? 2 : 1.2 });
  }

  update(dt, width, height) {
    for (const s of this.systems) s.update(dt);
    for (const r of this.ribbons) {
      if (!r.update(dt, this.camera)) {
        r.dispose();
        this.ribbons.delete(r);
      }
    }
    for (const tr of this.transients) {
      tr.t += dt;
      const k = Math.min(1, tr.t / tr.dur);
      tr.update(k);
      if (k >= 1) {
        this.scene.remove(tr.obj);
        tr.dispose?.();
        tr.obj.material?.dispose?.();
        tr.done = true;
      }
    }
    this.transients = this.transients.filter((t) => !t.done);
    const v = new THREE.Vector3();
    for (const t of this.texts) {
      t.t += dt;
      const k = t.t / t.dur;
      v.copy(t.pos);
      v.y += k * 1.5;
      v.project(this.camera);
      t.el.style.transform = `translate(-50%, -50%) translate(${((v.x + 1) / 2) * width}px, ${((1 - v.y) / 2) * height}px)`;
      t.el.style.opacity = String(Math.min(1, 2 * (1 - k)));
      if (k >= 1) {
        t.el.remove();
        t.done = true;
      }
    }
    this.texts = this.texts.filter((t) => !t.done);
  }

  clear() {
    for (const tr of this.transients) {
      this.scene.remove(tr.obj);
      tr.dispose?.();
    }
    this.transients = [];
    for (const r of this.ribbons) r.dispose();
    this.ribbons.clear();
    for (const s of this.systems) s.clear();
    for (const t of this.texts) t.el.remove();
    this.texts = [];
  }
}

