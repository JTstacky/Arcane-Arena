// Visual effects: a pooled GPU particle system, expanding shockwave rings,
// lightning bolts and WC3-style floating text.

import * as THREE from 'three';

const MAX_PARTICLES = 6000;

const vert = /* glsl */ `
  attribute float size;
  attribute float alpha;
  attribute vec3 color;
  varying float vAlpha;
  varying vec3 vColor;
  uniform float scale;
  void main() {
    vAlpha = alpha;
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * scale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const frag = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vColor * (0.6 + a), a * vAlpha);
  }
`;

class Particles {
  constructor(scene, blending) {
    this.pos = new Float32Array(MAX_PARTICLES * 3);
    this.col = new Float32Array(MAX_PARTICLES * 3);
    this.size = new Float32Array(MAX_PARTICLES);
    this.alpha = new Float32Array(MAX_PARTICLES);
    this.vel = new Float32Array(MAX_PARTICLES * 3);
    this.life = new Float32Array(MAX_PARTICLES);
    this.maxLife = new Float32Array(MAX_PARTICLES);
    this.size0 = new Float32Array(MAX_PARTICLES);
    this.grav = new Float32Array(MAX_PARTICLES);
    this.drag = new Float32Array(MAX_PARTICLES);
    this.next = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { scale: { value: 400 } },
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    scene.add(this.points);
    this.geo = geo;
  }

  spawn(x, y, z, vx, vy, vz, color, size, life, grav = 0, drag = 0) {
    const i = this.next;
    this.next = (this.next + 1) % MAX_PARTICLES;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = color.r;
    this.col[i * 3 + 1] = color.g;
    this.col[i * 3 + 2] = color.b;
    this.size[i] = this.size0[i] = size;
    this.life[i] = this.maxLife[i] = life;
    this.grav[i] = grav;
    this.drag[i] = drag;
    this.alpha[i] = 1;
  }

  update(dt) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      const dr = 1 - this.drag[i] * dt;
      this.vel[i * 3] *= dr;
      this.vel[i * 3 + 2] *= dr;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * dr - this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.alpha[i] = k;
      this.size[i] = this.size0[i] * (0.4 + 0.6 * k);
    }
    for (const a of ['position', 'color', 'size', 'alpha']) this.geo.attributes[a].needsUpdate = true;
  }
}

const tmpColor = new THREE.Color();

export class Effects {
  constructor(scene, overlay, camera) {
    this.scene = scene;
    this.overlay = overlay;
    this.camera = camera;
    this.add = new Particles(scene, THREE.AdditiveBlending);
    this.norm = new Particles(scene, THREE.NormalBlending);
    this.transients = [];
    this.texts = [];
    this.ringGeo = new THREE.RingGeometry(0.85, 1, 48);
    this.ringGeo.rotateX(-Math.PI / 2);
  }

  setScale(h) {
    this.add.material.uniforms.scale.value = h * 0.6;
    this.norm.material.uniforms.scale.value = h * 0.6;
  }

  // ---- particle helpers (x, z are world coords; y is height)
  burst(x, y, z, color, { n = 20, speed = 4, size = 0.6, life = 0.6, up = 1, grav = 4, additive = true, drag = 1.5 } = {}) {
    const sys = additive ? this.add : this.norm;
    const c = tmpColor.set(color);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      sys.spawn(x, y, z, Math.cos(a) * s, (Math.random() * 0.8 + 0.2) * up * speed, Math.sin(a) * s, c, size * (0.6 + Math.random() * 0.8), life * (0.6 + Math.random() * 0.6), grav, drag);
    }
  }

  trail(x, y, z, color, size = 0.5, life = 0.35, jitter = 0.15) {
    this.add.spawn(
      x + (Math.random() - 0.5) * jitter, y + (Math.random() - 0.5) * jitter, z + (Math.random() - 0.5) * jitter,
      (Math.random() - 0.5) * 0.6, Math.random() * 0.6, (Math.random() - 0.5) * 0.6,
      tmpColor.set(color), size, life, -0.5, 0,
    );
  }

  smoke(x, y, z, color = '#444', size = 1.2, life = 1.2) {
    this.norm.spawn(x + (Math.random() - 0.5) * 0.5, y, z + (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5, 1 + Math.random(), (Math.random() - 0.5) * 0.5, tmpColor.set(color), size, life, -0.3, 0.5);
  }

  ring(x, z, radius, color, dur = 0.45, y = 0.08) {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.scale.setScalar(0.1);
    this.scene.add(m);
    this.transients.push({ obj: m, t: 0, dur, update: (k) => { m.scale.setScalar(0.1 + radius * k); m.material.opacity = 0.9 * (1 - k); } });
  }

  flash(x, z, radius, color, dur = 0.3) {
    const light = new THREE.PointLight(color, 40, radius * 5, 2);
    light.position.set(x, 1.5, z);
    this.scene.add(light);
    this.transients.push({ obj: light, t: 0, dur, update: (k) => (light.intensity = 40 * (1 - k)) });
  }

  bolt(x1, z1, x2, z2, color = '#bfe6ff') {
    const pts = [];
    const n = Math.max(4, Math.floor(Math.hypot(x2 - x1, z2 - z1) * 1.5));
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      const j = i === 0 || i === n ? 0 : 0.35;
      pts.push(new THREE.Vector3(x1 + (x2 - x1) * k + (Math.random() - 0.5) * j, 1.1 + (Math.random() - 0.5) * j, z1 + (z2 - z1) * k + (Math.random() - 0.5) * j));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const mk = (r, c, o) => new THREE.Mesh(new THREE.TubeGeometry(curve, n * 3, r, 5), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    const core = mk(0.05, '#ffffff', 1);
    const glow = mk(0.18, color, 0.6);
    const g = new THREE.Group();
    g.add(core, glow);
    this.scene.add(g);
    this.transients.push({ obj: g, t: 0, dur: 0.3, update: (k) => { core.material.opacity = 1 - k; glow.material.opacity = 0.6 * (1 - k); }, dispose: () => { core.geometry.dispose(); glow.geometry.dispose(); } });
    for (let i = 0; i < 12; i++) {
      const p = pts[Math.floor(Math.random() * pts.length)];
      this.trail(p.x, p.y, p.z, color, 0.4, 0.3, 0.3);
    }
  }

  // Floating text anchored at a world position (WC3's "texttag").
  text(x, y, z, str, color = '#fff', big = false) {
    const el = document.createElement('div');
    el.className = 'ftext' + (big ? ' big' : '');
    el.textContent = str;
    el.style.color = color;
    this.overlay.appendChild(el);
    this.texts.push({ el, pos: new THREE.Vector3(x, y, z), t: 0, dur: 1.2 });
  }

  update(dt, width, height) {
    this.add.update(dt);
    this.norm.update(dt);
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
    for (const tr of this.transients) this.scene.remove(tr.obj);
    this.transients = [];
    for (const t of this.texts) t.el.remove();
    this.texts = [];
  }
}
