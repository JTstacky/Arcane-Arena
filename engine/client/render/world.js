// The 3D world: builds maps, keeps a view object per server entity,
// interpolates between snapshots, plays events as effects and drives the
// Warcraft III camera.
//
// The camera copies WC3's default game camera (measured in-game): distance
// 1650 units (33 m) from a target on the ground, angle of attack 304° (56°
// down), looking north. WC3 renders a 4:3 image in which 1550 units fit
// across the screen centre; the vertical field of view below keeps that
// vertical extent, and wider windows see further to the sides. The camera does
// not follow your hero: scroll with the screen edges or arrow keys, Space
// centres it.

import * as THREE from 'three';
import { LOW } from '../device.js';
import * as M from './models.js';
import { Effects, artTexture, noiseTex } from './effects.js';
import { Missile } from './missiles.js';
import { play } from '../audio.js';
import { TICK_RATE } from '../../shared/constants.js';

const INTERP_DELAY = 0.11; // seconds behind the newest snapshot
const FIRE_COLORS = new Set(['#ff7a1a', '#ff4a1a', '#ffcf6a', '#ff8040']);
const CAM_PITCH = (56 * Math.PI) / 180;
const CAM_FOV = 2 * Math.atan(0.75 * (775 / 1650)) * (180 / Math.PI); // ≈ 38.8° vertical
export const CAM_DISTANCE = 1650 / 50;

// ------------------------------------------------------------ textures

function noiseTexture(base, vary, { size = 256, speckle = 0.5, tiles = false, cracks = false, blades = false } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const b = new THREE.Color(base);
  g.fillStyle = `#${b.getHexString()}`;
  g.fillRect(0, 0, size, size);
  const img = g.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * vary;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n * 0.8));
  }
  g.putImageData(img, 0, 0);
  // Soft blotches for large-scale variation.
  for (let i = 0; i < 40 * speckle; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 8 + Math.random() * 30;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const k = Math.random() < 0.5 ? 0.85 : 1.12;
    const cc = b.clone().multiplyScalar(k);
    grd.addColorStop(0, `rgba(${cc.r * 255 | 0},${cc.g * 255 | 0},${cc.b * 255 | 0},0.5)`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  if (blades) {
    for (let i = 0; i < 900; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const cc = b.clone().multiplyScalar(0.7 + Math.random() * 0.7);
      g.strokeStyle = `#${cc.getHexString()}`;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (Math.random() - 0.5) * 3, y - 3 - Math.random() * 3);
      g.stroke();
    }
  }
  if (tiles) {
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 2;
    const n = 4;
    for (let r = 0; r < n; r++) {
      const off = r % 2 ? size / n / 2 : 0;
      g.beginPath();
      g.moveTo(0, (r * size) / n);
      g.lineTo(size, (r * size) / n);
      g.stroke();
      for (let col = 0; col <= n; col++) {
        const x = (col * size) / n + off;
        g.beginPath();
        g.moveTo(x, (r * size) / n);
        g.lineTo(x, ((r + 1) * size) / n);
        g.stroke();
      }
    }
  }
  if (cracks) {
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    for (let i = 0; i < 14; i++) {
      let x = Math.random() * size;
      let y = Math.random() * size;
      g.beginPath();
      g.moveTo(x, y);
      for (let j = 0; j < 5; j++) {
        x += (Math.random() - 0.5) * 50;
        y += (Math.random() - 0.5) * 50;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const THEMES = {
  lava: { sky: '#1a0806', fog: '#2a0c06', floor: ['#6f6259', 40, { tiles: true }], sun: '#ffd0a0', hemi: ['#ffb080', '#401008'] },
  grass: { sky: '#88aacc', fog: '#9fb8c8', floor: ['#4f7a34', 40, { blades: true }], outer: ['#3a5a26', 30, { blades: true }], sun: '#fff2d8', hemi: ['#cfe6ff', '#3a4a20'] },
  dirt: { sky: '#8c7a66', fog: '#9a8670', floor: ['#8a6a48', 45, {}], outer: ['#5e4a34', 35, {}], sun: '#ffe2b8', hemi: ['#ffe8cc', '#4a3a28'] },
  stone: { sky: '#8aa0b8', fog: '#98a8b8', floor: ['#8e8a80', 35, { tiles: true }], outer: ['#46663a', 30, { blades: true }], sun: '#fff0dc', hemi: ['#dde8ff', '#404838'] },
  night: { sky: '#0c1428', fog: '#101a30', floor: ['#2c4a3a', 35, { blades: true }], outer: ['#1c3028', 30, { blades: true }], sun: '#9fb8ff', hemi: ['#5870b0', '#101810'], sunI: 1.4 },
  ice: { sky: '#aac8e0', fog: '#b8d4e8', floor: ['#cfe6f2', 25, { cracks: true }], sun: '#ffffff', hemi: ['#e0f0ff', '#406080'] },
};

// Animated lava / water surface.
// Painted lava (art/tex_lava) flows slowly in two layers at different scales,
// warped by noise, and its glow pulses. Until the texture has loaded, `hasMap`
// is 0 and the procedural version is drawn.
function liquidMaterial(kind) {
  const map = kind === 'lava' ? artTexture('tex_lava', (g, s) => { g.fillStyle = '#000'; g.fillRect(0, 0, s, s); }, { repeat: true, raw: true }) : null;
  const uniforms = { time: { value: 0 }, map: { value: map }, hasMap: { value: 0 }, noiseT: { value: noiseTex() } };
  if (map) {
    const check = () => (map.image?.naturalWidth ? (uniforms.hasMap.value = 1) : setTimeout(check, 200));
    check();
  }
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vWorld;
      void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
    `,
    fragmentShader: /* glsl */ `
      uniform float time; uniform sampler2D map; uniform float hasMap; uniform sampler2D noiseT; varying vec3 vWorld;
      // Noise comes from a precomputed tiling texture (see noiseTex).
      float fbm(vec2 p) { return texture2D(noiseT, p * 0.125).b * 0.97; }
      void main() {
        vec2 p = vWorld.xz * 0.12;
        ${kind === 'lava'
          ? `if (hasMap > 0.5) {
               vec2 uv = vWorld.xz / 12.0;
               vec2 d = vec2(fbm(uv * 1.3 + time * 0.03), fbm(uv * 1.3 - time * 0.025 + 7.0)) - 0.5;
               vec3 a = texture2D(map, uv + d * 0.09 + vec2(time * 0.006, time * 0.003)).rgb;
               vec3 b = texture2D(map, uv * 0.47 - d * 0.06 + vec2(-time * 0.004, time * 0.005)).rgb;
               vec3 col = max(a, b * 0.95);
               float heat = max(col.r - col.b, 0.0);
               float pulse = 0.9 + 0.2 * sin(time * 1.1 + fbm(uv * 2.5 + time * 0.05) * 7.0);
               gl_FragColor = vec4(col * (0.85 + heat * 0.9 * pulse), 1.0);
               return;
             }
             float n = fbm(p + vec2(time*0.05, time*0.03) + fbm(p*1.7 - time*0.04));
             float veins = smoothstep(0.45, 0.75, n);
             vec3 col = mix(vec3(0.35,0.03,0.0), vec3(1.0,0.35,0.02), veins);
             col = mix(col, vec3(1.0,0.85,0.35), smoothstep(0.72, 0.9, n));
             gl_FragColor = vec4(col * 1.6, 1.0);`
          : `float n = fbm(p*1.5 + vec2(time*0.04, -time*0.03) + fbm(p*2.0 + time*0.05));
             vec3 col = mix(vec3(0.02,0.12,0.25), vec3(0.15,0.45,0.65), n);
             col += smoothstep(0.7, 0.85, n) * 0.35;
             gl_FragColor = vec4(col, 1.0);`}
      }
    `,
  });
}

// ------------------------------------------------------------ world

export class World {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    // Resolution adapts to the frame rate (see adaptResolution): it starts
    // at the device's sharpness, capped, and only drops if frames run slow.
    this.maxRatio = Math.min(window.devicePixelRatio || 1, LOW ? 1.5 : 2);
    this.renderer.setPixelRatio(this.maxRatio);
    this.frameMs = 16.7;
    this.adaptT = 0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = LOW ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = !LOW;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.5, 400);
    this.hemi = new THREE.HemisphereLight('#fff', '#333', 1.2);
    this.sun = new THREE.DirectionalLight('#fff', 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(LOW ? 1024 : 2048, LOW ? 1024 : 2048);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.mapGroup = new THREE.Group();
    this.entGroup = new THREE.Group();
    this.scene.add(this.mapGroup, this.entGroup);
    this.fx = new Effects(this.scene, overlay, this.camera);

    this.views = new Map();
    this.snaps = [];
    this.pendingEvents = [];
    this.offset = null;
    this.colors = {}; // owner id -> hex
    this.spellColors = {}; // spell id -> hex, provided by the game
    this.names = {};
    this.myId = null;
    this.myUnit = null;
    this.focus = new THREE.Vector3();
    this.zoom = CAM_DISTANCE;
    this.follow = false;
    this.markers = [];
    this.time = 0;
    this.liquids = [];
    this.animated = [];
    this.floorMesh = null;
    this.linkBeams = [];
    this.onMessage = () => {};

    this.selGeo = new THREE.RingGeometry(0.72, 0.86, 40);
    this.selGeo.rotateX(-Math.PI / 2);
    this.rangeRing = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, depthWrite: false }));
    this.rangeRing.position.y = 0.06;
    this.rangeRing.visible = false;
    this.scene.add(this.rangeRing);
    // WC3's blue area-target reticle, shown on the cursor while targeting.
    this.reticle = new THREE.Group();
    this.reticle.add(
      new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#4aa8ff', transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false })),
      new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#2a78ff', transparent: true, opacity: 0.18, depthWrite: false, toneMapped: false })),
    );
    this.reticle.position.y = 0.07;
    this.reticle.visible = false;
    this.scene.add(this.reticle);
    this.arrowGeo = new THREE.ConeGeometry(0.22, 0.6, 3).rotateZ(-Math.PI / 2).rotateX(-Math.PI / 2);
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fx.setScale(h * this.renderer.getPixelRatio());
    this.width = w;
    this.height = h;
  }

  // -------------------------------------------------------------- map

  setMap(map) {
    this.map = map;
    for (const v of this.views.values()) this.removeView(v);
    this.views.clear();
    this.snaps = [];
    this.pendingEvents = [];
    this.fx.clear();
    this.mapGroup.clear();
    this.liquids = [];
    this.animated = [];
    this.floorMesh = null;
    const theme = THEMES[map.theme] || THEMES.grass;
    this.scene.background = new THREE.Color(theme.sky);
    this.scene.fog = new THREE.Fog(theme.fog, 45, 110);
    this.hemi.color.set(theme.hemi[0]);
    this.hemi.groundColor.set(theme.hemi[1]);
    this.sun.color.set(theme.sun);
    this.sun.intensity = theme.sunI ?? 2.4;
    const B = map.bounds || 25;
    const cam = this.sun.shadow.camera;
    cam.left = -B;
    cam.right = B;
    cam.top = B;
    cam.bottom = -B;
    cam.far = 150;
    cam.updateProjectionMatrix();

    const f = map.floor;
    const floorTex = noiseTexture(theme.floor[0], theme.floor[1], theme.floor[2]);

    if (map.theme === 'lava' || map.theme === 'ice') {
      const liquid = new THREE.Mesh(new THREE.PlaneGeometry(260, 260).rotateX(-Math.PI / 2), liquidMaterial(map.theme === 'lava' ? 'lava' : 'water'));
      liquid.position.y = -0.35;
      this.mapGroup.add(liquid);
      this.liquids.push(liquid.material);
      if (map.theme === 'lava') {
        this.buildLavaFloor(f.r);
        this.addLavaRocks(f.r);
      } else {
        // The platform is a unit disc scaled by the live arena radius.
        const geo = new THREE.CylinderGeometry(1, 1.04, 1, 128, 1);
        floorTex.repeat.set(f.r / 2.5, f.r / 2.5);
        const side = M.mat('#9cc4dc');
        const topTex = floorTex;
        const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: map.theme === 'ice' ? 0.25 : 0.85, metalness: map.theme === 'ice' ? 0.1 : 0 });
        const disc = new THREE.Mesh(geo, [side, top, side]);
        disc.position.y = -0.5;
        disc.receiveShadow = true;
        disc.scale.set(f.r, 1, f.r);
        this.mapGroup.add(disc);
        this.floorMesh = disc;
        this.floorR = null;
        this.setFloorRadius(f.r);
          for (let i = 0; i < 18; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = f.r + 8 + Math.random() * 14;
            const berg = M.rock(1.5 + Math.random() * 2);
            berg.children[0].material = M.mat('#e8f4ff');
            berg.position.set(Math.cos(a) * r, -0.8, Math.sin(a) * r);
            this.mapGroup.add(berg);
          }
      }
    } else {
      const outerTex = noiseTexture(theme.outer[0], theme.outer[1], theme.outer[2]);
      outerTex.repeat.set(30, 30);
      const outer = new THREE.Mesh(new THREE.PlaneGeometry(240, 240).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: outerTex, roughness: 1 }));
      outer.position.y = -0.02;
      outer.receiveShadow = true;
      this.mapGroup.add(outer);
      let floor;
      if (f.shape === 'rect') {
        floorTex.repeat.set(f.w / 5, f.h / 5);
        floor = new THREE.Mesh(new THREE.PlaneGeometry(f.w, f.h).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 }));
        // Stone curb along the border.
        const curb = M.mat('#77726a');
        const t = 0.35;
        for (const [w, h, x, z] of [[f.w + t * 2, t, 0, -f.h / 2 - t / 2], [f.w + t * 2, t, 0, f.h / 2 + t / 2], [t, f.h, -f.w / 2 - t / 2, 0], [t, f.h, f.w / 2 + t / 2, 0]]) {
          const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, h), curb);
          m.position.set(x, 0.15, z);
          m.castShadow = m.receiveShadow = true;
          this.mapGroup.add(m);
        }
      } else {
        floorTex.repeat.set(f.r / 3, f.r / 3);
        floor = new THREE.Mesh(new THREE.CircleGeometry(f.r, 96).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 }));
        const curb = new THREE.Mesh(new THREE.TorusGeometry(f.r + 0.15, 0.22, 6, 96).rotateX(Math.PI / 2), M.mat('#77726a'));
        curb.position.y = 0.05;
        curb.castShadow = curb.receiveShadow = true;
        this.mapGroup.add(curb);
      }
      floor.position.y = 0.01;
      floor.receiveShadow = true;
      this.mapGroup.add(floor);
    }

    for (const p of map.props || []) this.addProp(p, map.theme);
  }

  addProp(p, theme) {
    let obj;
    switch (p.t) {
      case 'tree': obj = theme === 'ice' ? M.snowTree(p.s) : M.tree(p.s); break;
      case 'rock': obj = M.rock(p.s); break;
      case 'pillar': obj = M.pillar(p.s); break;
      case 'torch': obj = M.torch(); this.animated.push({ type: 'torch', obj }); break;
      case 'moonwell': obj = M.moonwell(); break;
      case 'goldmine': obj = M.goldmine(); break;
      case 'flag': obj = M.flag(); break;
      case 'line': {
        const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
        obj = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.35).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: p.c, transparent: true, opacity: 0.85 }));
        obj.rotation.y = -Math.atan2(p.y2 - p.y1, p.x2 - p.x1);
        obj.position.set((p.x1 + p.x2) / 2, 0.03, (p.y1 + p.y2) / 2);
        this.mapGroup.add(obj);
        return;
      }
      default: return;
    }
    obj.position.set(p.x, obj.position.y, p.y);
    this.mapGroup.add(obj);
  }

  // -------------------------------------------------------- snapshots

  pushSnapshot(snap) {
    // Clock sync: `offset` maps game time to local time. Each snapshot gives
    // a sample (arrival minus game time) that is the true offset plus network
    // delay, so the smallest sample over the last couple of seconds is the best
    // estimate. The offset eases toward it so that render time speeds up or
    // slows down gently instead of jumping. It can follow a host whose clock
    // runs a little fast or slow.
    const now = performance.now() / 1000;
    const t = snap.tk / TICK_RATE;
    const sample = now - t;
    this.samples = this.samples || [];
    this.samples.push(sample);
    if (this.samples.length > 40) this.samples.shift();
    const target = Math.min(...this.samples);
    if (this.offset == null || Math.abs(target - this.offset) > 0.5) this.offset = target;
    else this.offset += (target - this.offset) * 0.1;
    const ents = new Map();
    for (const e of snap.ents) ents.set(e.id, e);
    this.snaps.push({ t, ents, links: snap.links || [], snap });
    if (this.snaps.length > 30) this.snaps.shift();
    for (const e of snap.ev || []) {
      if (e.k === 'msg') this.onMessage(e);
      else this.pendingEvents.push({ t, e });
    }
    const uid = snap.me?.uid ?? null;
    // A new warlock (each shop and each round) recentres the camera on it, as
    // the map pans every player's camera to their warlock.
    if (uid != null && uid !== this.myUnit) this.recentre = true;
    this.myUnit = uid;
  }

  renderTime() {
    return performance.now() / 1000 - (this.offset ?? 0) - INTERP_DELAY;
  }

  // Finds the pair of snapshots around render time.
  bracket(rt) {
    const s = this.snaps;
    if (!s.length) return null;
    if (rt <= s[0].t) return [s[0], s[0], 0];
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].t <= rt) {
        const a = s[i];
        const b = s[i + 1] || a;
        const k = b === a ? 0 : (rt - a.t) / (b.t - a.t);
        return [a, b, Math.min(1, k)];
      }
    }
    return [s[0], s[0], 0];
  }

  // -------------------------------------------------------------- views

  makeView(e) {
    const color = this.colors[e.o] || '#cccccc';
    let obj;
    const v = { id: e.id, k: e.k, owner: e.o, deadT: 0 };
    switch (e.k) {
      case 'warlock': obj = M.warlock(color); break;
      case 'paladin': obj = M.paladin(color); break;
      case 'kodo': obj = M.kodo(); break;
      case 'golem': obj = M.golem(); break;
      case 'coin': obj = M.coin(); break;
      case 'goldbag': obj = M.goldbag(); break;
      case 'meteor': {
        obj = new THREE.Group();
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ff5020', transparent: true, opacity: 0.8, depthWrite: false }));
        const fill = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ff3010', transparent: true, opacity: 0.25, depthWrite: false }));
        ring.scale.setScalar(e.r);
        ring.position.y = fill.position.y = 0.07;
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.8, 0), new THREE.MeshStandardMaterial({ color: '#3a2010', emissive: '#ff4010', emissiveIntensity: 1.5, flatShading: true }));
        obj.add(ring, fill, rock);
        v.parts = { fill, rock, r: e.r };
        break;
      }
      case 'warn': {
        obj = new THREE.Group();
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ff2020', transparent: true, opacity: 0.9, depthWrite: false }));
        const fill = new THREE.Mesh(new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ff2020', transparent: true, opacity: 0.3, depthWrite: false }));
        ring.scale.setScalar(e.r);
        ring.position.y = fill.position.y = 0.05;
        const shell = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), M.mat('#222'));
        obj.add(ring, fill, shell);
        v.parts = { fill, rock: shell, r: e.r };
        break;
      }
      case 'wisparm': {
        const n = Math.ceil((e.r1 - e.r0) / 0.85);
        const inst = new THREE.InstancedMesh(new THREE.SphereGeometry(0.3, 10, 8), new THREE.MeshBasicMaterial({ color: '#bff4ff', toneMapped: false }), n);
        inst.frustumCulled = false;
        obj = new THREE.Group();
        obj.add(inst);
        v.parts = { inst, n };
        break;
      }
      case 'hill': {
        obj = new THREE.Group();
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffd24a', transparent: true, opacity: 0.9, depthWrite: false }));
        const fill = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffd24a', transparent: true, opacity: 0.18, depthWrite: false }));
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 8, 32, 1, true), new THREE.MeshBasicMaterial({ color: '#ffd24a', transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
        ring.position.y = fill.position.y = 0.05;
        beam.position.y = 4;
        obj.add(ring, fill, beam);
        obj.scale.set(e.r, 1, e.r);
        v.parts = { ring, fill, beam };
        break;
      }
      case 'floor':
        obj = new THREE.Group();
        break;
      case 'obstacle': {
        obj = M.rock(e.r * 1.1);
        obj.children[0].scale.y = 1.6;
        obj.children[0].material = M.mat('#4a3c34');
        this.fx.burst(e.x, 0.5, e.y, '#6a5040', { n: 20, speed: 3, size: 1, life: 0.8, additive: false });
        break;
      }
      default:
        if (e.k.startsWith('p_')) {
          const spell = e.k.slice(2);
          const c = this.spellColors[spell] || '#fff';
          v.missile = new Missile(this.fx, spell, c);
          obj = v.missile.obj;
          v.color = c;
          v.spell = spell;
        } else {
          obj = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), M.mat('#f0f'));
        }
    }
    // Models are drawn larger than their collision size, as in WC3.
    if (e.k === 'warlock' || e.k === 'paladin') obj.userData.body.scale.setScalar(1.45);
    v.obj = obj;
    this.entGroup.add(obj);

    if (e.k === 'warlock' || e.k === 'paladin') {
      const isMe = e.o === this.myId;
      const sel = new THREE.Mesh(this.selGeo, new THREE.MeshBasicMaterial({ color: isMe ? '#30ff30' : color, transparent: true, opacity: isMe ? 0.95 : 0.55, depthWrite: false }));
      sel.position.y = 0.05;
      obj.add(sel);
      v.sel = sel;
      const bar = document.createElement('div');
      bar.className = 'unitbar' + (isMe ? ' me' : '');
      bar.innerHTML = `<div class="uname" style="color:${color}">${escapeHtml(this.names[e.o] || '')}</div>${e.mhp ? '<div class="hpbar"><div class="hpfill"></div></div>' : ''}`;
      this.overlay.appendChild(bar);
      v.bar = bar;
      v.hpFill = bar.querySelector('.hpfill');
      // A painted magic bubble (art/fx_shield_white, tinted).
      const shield = new THREE.Sprite(new THREE.SpriteMaterial({ map: artTexture('fx_shield_white'), color: '#ffe066', transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      shield.position.y = 0.9;
      shield.visible = false;
      shield.renderOrder = 9;
      // The glow on the staff (the Blood Elf wizard's is green).
      const orb = obj.userData.orb;
      if (orb) {
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: artTexture('fx_flare'), color: '#7dff6a', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
        glow.scale.setScalar(0.9);
        orb.add(glow);
        v.staffGlow = glow;
      }
      obj.add(shield);
      v.shield = shield;
      const bomb = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 10), M.mat('#222', { metalness: 0.4 }));
      bomb.position.set(0, 3.0, 0);
      bomb.visible = false;
      obj.add(bomb);
      v.bomb = bomb;
    }
    return v;
  }

  removeView(v) {
    v.missile?.release();
    this.entGroup.remove(v.obj);
    v.bar?.remove();
    v.obj.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
    });
  }

  // -------------------------------------------------------------- frame

  // Dynamic resolution: every 2 s, if frames average slower than ~50 fps
  // the pixel ratio steps down (never below 0.75); with headroom it climbs
  // back to the device's full sharpness. Only slow devices ever lose detail.
  adaptResolution(dt) {
    if (dt <= 0 || dt > 0.25) return; // tab switches and hitches aren't the steady rate
    this.frameMs += (dt * 1000 - this.frameMs) * 0.05;
    this.adaptT += dt;
    if (this.adaptT < 2) return;
    this.adaptT = 0;
    const cur = this.renderer.getPixelRatio();
    let next = cur;
    if (this.frameMs > 20) next = Math.max(0.75, cur - 0.25);
    else if (this.frameMs < 14) next = Math.min(this.maxRatio, cur + 0.25);
    if (next !== cur) {
      this.renderer.setPixelRatio(next);
      this.resize();
    }
  }

  render(dt) {
    this.adaptResolution(dt);
    this.pred = this.predictor && this.offset != null ? this.predictor.frame(performance.now() / 1000 - this.offset, dt) : null;
    this.time += dt;
    for (const m of this.liquids) m.uniforms.time.value = this.time;
    const rt = this.renderTime();
    const br = this.bracket(rt);

    // Fire events whose time has come.
    if (this.pendingEvents.length) {
      const due = [];
      this.pendingEvents = this.pendingEvents.filter((p) => {
        if (p.t <= rt + 0.02) {
          due.push(p.e);
          return false;
        }
        return true;
      });
      for (const e of due) this.handleEvent(e);
    }

    if (br) {
      const [a, b, k] = br;
      const latest = this.snaps[this.snaps.length - 1];
      // Remove views for entities that no longer exist.
      for (const [id, v] of this.views) {
        const flying = v.spell && a.ents.has(id) && rt - a.t <= (b.t - a.t) / 2;
        if (!b.ents.has(id) && !latest.ents.has(id) && !flying) {
          this.removeView(v);
          this.views.delete(id);
        }
      }
      this.frameT = { ta: a.t, tb: b.t, rt };
      for (const [id, eb] of b.ents) {
        const ea = a.ents.get(id) || eb;
        let v = this.views.get(id);
        if (!v) {
          v = this.makeView(eb);
          this.views.set(id, v);
        }
        this.updateView(v, ea, eb, k, dt);
      }
      // Hide views that exist only in newer snapshots.
      for (const [id, v] of this.views) if (!b.ents.has(id)) v.obj.visible = false;
      // A projectile that died between the two snapshots flies on for half the
      // gap, so it vanishes about when its impact effect plays.
      for (const [id, ea] of a.ents) {
        const v = this.views.get(id);
        if (!v?.spell || b.ents.has(id) || rt - a.t > (b.t - a.t) / 2) continue;
        const d = rt - a.t;
        v.obj.visible = true;
        v.missile.update(ea.x + (ea.vx ?? 0) * d, ea.y + (ea.vy ?? 0) * d, dt, true);
      }
      this.updateLinks(b, a, k);
      const snap = b.snap;
      if (this.floorMesh && snap.arena) this.setFloorRadius(lerp(a.snap.arena?.r ?? snap.arena.r, snap.arena.r, k));
      const fl = [...b.ents.values()].find((e) => e.k === 'floor');
      if (this.floorMesh && fl) this.setFloorRadius(fl.r);
    }

    for (const a of this.animated) {
      if (a.type === 'torch') {
        a.obj.userData.flame.scale.set(1, 0.8 + Math.random() * 0.4, 1);
        if (Math.random() < 0.3) this.fx.trail(a.obj.position.x, 1.9, a.obj.position.z, '#ff9a30', 0.35, 0.5, 0.1);
      }
    }

    if (this.recentre && this.myView()) {
      this.recentre = false;
      this.centerOnMe();
    }
    this.updateMarkers(dt);
    if (this.lab) this.updateLab(dt);
    this.updateCamera(dt);
    this.fx.update(dt, this.width, this.height);
    if (LOW) {
      // Phones redraw the shadow map every other frame (at 60 fps the
      // shadows still move at 30; the difference is hard to see).
      this.shadowFlip = !this.shadowFlip;
      this.renderer.shadowMap.needsUpdate = this.shadowFlip;
    }
    this.renderer.render(this.scene, this.camera);
    this.positionBars();
  }

  // Movement Lab (F8): breadcrumb trail of your hero's path plus a facing
  // arrow and live readouts, for comparing turning arcs with real WC3.
  toggleLab() {
    this.lab = !this.lab;
    if (!this.labObj) {
      const n = 240;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const trail = new THREE.Points(geo, new THREE.PointsMaterial({ color: '#30ff30', size: 0.18, depthWrite: false }));
      trail.frustumCulled = false;
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 2.2, '#ffffff', 0.5, 0.3);
      this.labObj = { trail, arrow, n, i: 0, acc: 0, last: null };
      this.scene.add(trail, arrow);
    }
    this.labObj.trail.visible = this.labObj.arrow.visible = this.lab;
    document.getElementById('labinfo').hidden = !this.lab;
  }

  updateLab(dt) {
    const me = this.myView();
    const L = this.labObj;
    if (!me) return;
    const p = me.obj.position;
    L.arrow.position.set(p.x, 0.15, p.z);
    const f = -me.obj.rotation.y;
    L.arrow.setDirection(new THREE.Vector3(Math.cos(f), 0, Math.sin(f)));
    L.acc += dt;
    if (L.acc >= 0.03) {
      const pos = L.trail.geometry.attributes.position;
      pos.setXYZ(L.i % L.n, p.x, 0.08, p.z);
      pos.needsUpdate = true;
      L.i++;
      const now = performance.now() / 1000;
      if (L.last) {
        const dtt = now - L.last.t;
        const speed = Math.hypot(p.x - L.last.x, p.z - L.last.z) / dtt;
        let df = f - L.last.f;
        while (df > Math.PI) df -= Math.PI * 2;
        while (df < -Math.PI) df += Math.PI * 2;
        const turn = Math.abs(df) / dtt;
        L.speed = (L.speed ?? speed) * 0.7 + speed * 0.3;
        L.turn = (L.turn ?? turn) * 0.7 + turn * 0.3;
        document.getElementById('labinfo').textContent =
          `Movement Lab (F8)  facing ${Math.round((((f * 180) / Math.PI) % 360 + 360) % 360)}°  turn ${Math.round((L.turn * 180) / Math.PI)}°/s  speed ${L.speed.toFixed(2)} m/s`;
      }
      L.last = { x: p.x, z: p.z, f, t: now };
      L.acc = 0;
    }
  }

  // The lava arena's floor: marble slabs whose edge is drawn in the shader,
  // not as a hard circle. Toward the edge the slabs darken into scorched
  // crust, the border wobbles with noise (about ±1 m around the true lava
  // line), glows and fades into the lava.
  // For speed it is two meshes: an opaque inner disc, drawn before the lava
  // so the lava under it is never shaded, and a ring that does the noisy
  // edge. The texture is mapped from world position, so both line up.
  buildLavaFloor(r) {
    const map = artTexture('tex_marble', (g, s) => { g.fillStyle = '#8a8580'; g.fillRect(0, 0, s, s); }, { repeat: true });
    const uR = { value: r };
    const material = (edge) => {
      const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.85, transparent: edge });
      // Both variants share one onBeforeCompile source, so name them apart
      // or three.js would reuse one compiled program for both.
      mat.customProgramCacheKey = () => (edge ? 'lava-floor-edge' : 'lava-floor-inner');
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uR = uR;
        sh.uniforms.noiseT = { value: noiseTex() };
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec2 vW;')
          .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvW = (modelMatrix * vec4(transformed, 1.0)).xz;');
        // Slabs are 128 units (2.56 m); the texture holds 4 x 4 of them.
        const sample = 'vec4 sampledDiffuseColor = texture2D(map, vW / 10.24);\ndiffuseColor *= sampledDiffuseColor;';
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vW;\nuniform float uR;');
        if (!edge) {
          sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', sample);
          return;
        }
        sh.fragmentShader = sh.fragmentShader
          .replace('uniform float uR;', `uniform float uR;
uniform sampler2D noiseT; // precomputed tiling noise (see noiseTex)
float vnoise(vec2 p) { return texture2D(noiseT, p * 0.125).g; }
float fbm(vec2 p) { return texture2D(noiseT, p * 0.125).r; }`)
          .replace('#include <map_fragment>', `${sample}
float edgeN = fbm(vW * 0.3) - 0.5 + (vnoise(vW * 1.4) - 0.5) * 0.35;
float inside = uR + edgeN * 1.6 - length(vW); // metres inside the ragged edge
// Scorched crust creeps in patchily from the edge.
// Always darkest at the lip; noise only varies how far in the crust reaches.
float reach = 2.0 + fbm(vW * 0.7 + 11.0) * 4.4; // 2 to 6.4 m
float scorch = pow(1.0 - smoothstep(0.0, reach, inside), 0.8);
scorch *= 0.8 + 0.4 * fbm(vW * 3.0);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.08, 0.05, 0.035), clamp(scorch * 1.5, 0.0, 0.95));
diffuseColor.a *= smoothstep(-0.1, 0.45, inside);`)
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
float heat = 1.0 - smoothstep(0.15, 0.95, inside + (vnoise(vW * 2.2) - 0.5) * 0.7);
totalEmissiveRadiance += vec3(1.0, 0.22, 0.02) * heat * heat * heat * (0.8 + vnoise(vW * 2.7) * 1.4);`);
      };
      return mat;
    };
    const inner = new THREE.Mesh(new THREE.CircleGeometry(1, 96).rotateX(-Math.PI / 2), material(false));
    inner.receiveShadow = true;
    inner.renderOrder = -1; // before the lava: the lava under it fails the depth test
    const ring = new THREE.Mesh(new THREE.BufferGeometry(), material(true));
    ring.receiveShadow = true;
    ring.renderOrder = 1;
    this.mapGroup.add(inner, ring);
    this.floorMesh = inner;
    inner.userData = { flat: true, uR, ring };
    this.floorR = null;
    this.setFloorRadius(r);
  }

  // Volcanic rocks jutting out of the lava sea, and the lava's glow.
  addLavaRocks(r0) {
    const rockMat = new THREE.MeshStandardMaterial({ map: artTexture('tex_rock', (g, s) => { g.fillStyle = '#2a2220'; g.fillRect(0, 0, s, s); }, { repeat: true }), color: '#c8b4a4', emissive: '#5a1a06', emissiveIntensity: 0.6, roughness: 0.95, flatShading: true });
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = r0 + 6 + Math.random() * 16;
      const rock = M.lavaRock(1 + Math.random() * 2.5);
      rock.children[0].material = rockMat;
      rock.position.set(Math.cos(a) * r, -0.6, Math.sin(a) * r);
      this.mapGroup.add(rock);
    }
    const glow = new THREE.PointLight('#ff5a10', 30, 60, 1.2);
    glow.position.set(0, -2, 0);
    this.mapGroup.add(glow);
  }

  setFloorRadius(r) {
    r = Math.max(0.01, r);
    if (r === this.floorR) return;
    const ud = this.floorMesh.userData;
    if (ud.flat) {
      // Past this far in, the scorch and the ragged edge never reach.
      const EDGE = 7;
      const ri = Math.max(0, r - EDGE);
      this.floorMesh.visible = ri > 0.05;
      this.floorMesh.scale.set(Math.max(0.01, ri + 0.02), 1, Math.max(0.01, ri + 0.02)); // a hair of overlap
      ud.ring.geometry.dispose();
      ud.ring.geometry = new THREE.RingGeometry(ri, r + 1.3, 128, 1).rotateX(-Math.PI / 2);
      ud.uR.value = r;
      this.floorR = r;
      return;
    }
    this.floorMesh.scale.set(r, 1, r);
    this.floorR = r;
  }

  // Where a projectile is at render time. Snapshots carry its velocity, so
  // between two snapshots it follows a cubic Hermite curve (exact for straight
  // flight, smooth for homing and boomerang arcs); a projectile newer than the
  // earlier snapshot is traced back along its velocity to its launch; past the
  // newest snapshot it is carried forward briefly. So it never waits or jumps.
  projectilePos(a, b) {
    const { ta, tb, rt } = this.frameT;
    if (a !== b && tb > ta) {
      const h = tb - ta;
      const s = Math.max(0, Math.min(1, (rt - ta) / h));
      const s2 = s * s;
      const s3 = s2 * s;
      const h00 = 2 * s3 - 3 * s2 + 1;
      const h10 = s3 - 2 * s2 + s;
      const h01 = -2 * s3 + 3 * s2;
      const h11 = s3 - s2;
      return {
        x: h00 * a.x + h10 * h * (a.vx ?? 0) + h01 * b.x + h11 * h * (b.vx ?? 0),
        z: h00 * a.y + h10 * h * (a.vy ?? 0) + h01 * b.y + h11 * h * (b.vy ?? 0),
        born: true,
      };
    }
    // Only one snapshot has it: extrapolate from it (backward to the launch,
    // or forward up to 0.15 s).
    const d = Math.max(-(b.a ?? 0), Math.min(0.15, rt - tb));
    return { x: b.x + (b.vx ?? 0) * d, z: b.y + (b.vy ?? 0) * d, born: rt - tb >= -(b.a ?? 0) - 1e-3 };
  }

  updateView(v, a, b, k, dt) {
    const o = v.obj;
    o.visible = true;
    let x = lerp(a.x, b.x, k);
    let z = lerp(a.y, b.y, k);
    if (v.spell && this.frameT) {
      const p = this.projectilePos(a, b);
      x = p.x;
      z = p.z;
      if (!p.born) o.visible = false;
    }
    let f = lerpAngle(a.f ?? 0, b.f ?? 0, k);
    // The player's own hero is drawn where the prediction puts it (it
    // reacts to orders at once), everyone else from the snapshot timeline.
    const P = v.id === this.myUnit && !b.dead ? this.pred : null;
    if (P) {
      x = P.x;
      z = P.y;
      f = P.f;
    }
    v.x = x;
    v.z = z;
    const fx = b.fx || [];
    switch (v.k) {
      case 'warlock':
      case 'paladin': {
        o.position.x = x;
        o.position.z = z;
        o.rotation.y = -f;
        const body = o.userData.body;
        const moving = (P ? P.moving : b.mv) && !b.dead;
        const turning = (P ? P.turning : b.tn) && !b.dead; // shuffling round on the spot
        v.walk = (v.walk || 0) + dt * (moving ? 12 : turning ? 9 : 0);
        body.position.y = moving ? Math.abs(Math.sin(v.walk)) * 0.08 : 0;
        const legAmp = moving ? 0.5 : turning ? 0.2 : 0;
        if (o.userData.legL) {
          o.userData.legL.rotation.z = Math.sin(v.walk) * legAmp;
          o.userData.legR.rotation.z = -Math.sin(v.walk) * legAmp;
        }
        // Cast animation: wind up during the cast point, release on the effect.
        const windup = fx.includes('casting');
        v.raise = Math.max(0, Math.min(1, (v.raise || 0) + dt * (windup ? 8 : -5)));
        if (v.castT > 0) v.castT -= dt;
        const swing = v.castT > 0 ? Math.sin((v.castT / 0.3) * Math.PI) : 0;
        if (v.staffGlow && !b.dead) {
          v.staffGlow.scale.setScalar(0.9 + v.raise * 0.7 + swing * 1.4 + Math.sin(this.time * 7 + v.id) * 0.08);
          if ((moving || v.raise > 0.1) && Math.random() < 0.35) {
            v.staffGlow.getWorldPosition(this._wp || (this._wp = new THREE.Vector3()));
            this.fx.trail(this._wp.x, this._wp.y, this._wp.z, '#6aff50', 0.35, 0.4, 0.05);
          }
        }
        o.userData.staff.rotation.x = -(v.raise * 0.9 + swing * 0.6);
        // Sinks a little when standing in lava.
        const inLava = fx.includes('burn');
        const targetY = inLava ? -0.3 : 0;
        o.position.y += (targetY - o.position.y) * Math.min(1, dt * 8);
        if (inLava && Math.random() < 0.6) this.fx.trail(x + (Math.random() - 0.5) * 0.8, 0.3 + Math.random(), z + (Math.random() - 0.5) * 0.8, Math.random() < 0.5 ? '#ff6a10' : '#ffb030', 0.6, 0.6, 0.2);
        v.shield.visible = fx.includes('shield') || fx.includes('rush') || fx.includes('invuln');
        if (v.shield.visible) {
          const shieldR = fx.includes('shield') ? b.sr || 1 : 1;
          v.shield.scale.setScalar(shieldR * 2.3 * (1 + Math.sin(this.time * 9) * 0.02));
          v.shield.position.y = shieldR > 1.5 ? 0.6 : 1.0;
          v.shield.material.color.set(fx.includes('shield') ? '#ffe066' : fx.includes('rush') ? '#7fe0ff' : '#ffffff');
          v.shield.material.opacity = (fx.includes('shield') ? 0.75 : 0.55) + Math.sin(this.time * 20) * 0.08;
          v.shield.material.rotation += dt * 0.4;
        }
        if (fx.includes('slow') && Math.random() < 0.3) this.fx.trail(x, 0.4, z, '#d0102a', 0.4, 0.5, 0.6);
        v.bomb.visible = fx.includes('bomb');
        if (v.bomb.visible && Math.random() < 0.5) this.fx.trail(x, 3.35, z, '#ffcc40', 0.3, 0.3, 0.05);
        const invis = fx.includes('invis');
        setOpacity(o, invis ? 0.3 : 1);
        if (fx.includes('dash')) this.fx.trail(x, 0.8, z, '#ffe8a8', 0.8, 0.3, 0.4);
        if (fx.includes('finished') && !v.cheered) {
          v.cheered = true;
          this.fx.burst(x, 1.5, z, '#ffd700', { n: 30, speed: 4 });
        }
        if (b.dead) {
          v.deadT += dt;
          body.rotation.z = Math.min(Math.PI / 2, v.deadT * 4);
          o.position.y = -Math.min(1.5, Math.max(0, v.deadT - 0.8) * 0.8);
          v.sel.visible = false;
        } else {
          v.deadT = 0;
          body.rotation.z = 0;
          v.sel.visible = true;
        }
        if (v.hpFill && b.mhp && b.hp !== v.hpShown) {
          // Only touch the DOM when the health changes.
          v.hpShown = b.hp;
          const frac = Math.max(0, b.hp / b.mhp);
          v.hpFill.style.width = `${frac * 100}%`;
          v.hpFill.style.background = frac > 0.6 ? '#2fdc2f' : frac > 0.3 ? '#e8d020' : '#e82020';
        }
        v.visibleBar = !b.dead && !(invis && b.o !== this.myId);
        break;
      }
      case 'kodo':
      case 'golem': {
        o.position.set(x, 0, z);
        o.rotation.y = -f;
        v.walk = (v.walk || 0) + dt * 10;
        o.userData.body.position.y = Math.abs(Math.sin(v.walk)) * 0.15;
        if (v.k === 'kodo' && Math.random() < 0.3) this.fx.smoke(x - Math.cos(f) * 1.2, 0.2, z - Math.sin(f) * 1.2, '#8a7a60', 1.2, 0.8);
        break;
      }
      case 'coin':
      case 'goldbag':
        o.position.set(x, Math.sin(this.time * 3 + v.id) * 0.1, z);
        o.rotation.y = this.time * 2.5;
        if (Math.random() < 0.05) this.fx.trail(x, 0.9, z, '#fff3a0', 0.3, 0.5, 0.5);
        break;
      case 'meteor':
      case 'warn': {
        o.position.set(x, 0, z);
        const t = b.t ?? 0;
        const p = v.parts;
        p.fill.scale.setScalar(Math.max(0.01, p.r * t));
        const fall = v.k === 'meteor' ? t : Math.max(0, (t - 0.6) / 0.4);
        p.rock.visible = fall > 0;
        p.rock.position.set(-(1 - fall) * 6, 0.5 + (1 - fall) * 22, (1 - fall) * 4);
        if (v.k === 'meteor' && fall > 0) {
          const rx = o.position.x + p.rock.position.x;
          const rz = o.position.z + p.rock.position.z;
          this.fx.fire(rx, p.rock.position.y + 0.4, rz, 1.8 + Math.random(), 0.45, { vx: -3, vy: 5, vz: 2 });
          if (Math.random() < 0.5) this.fx.smoke(rx, p.rock.position.y + 0.8, rz, '#2a2220', 1.4, 1);
        }
        break;
      }
      case 'wisparm': {
        const ang = lerp(a.a, b.a, k);
        const g = lerp(a.g, b.g, k);
        const p = v.parts;
        const dummy = new THREE.Object3D();
        let i = 0;
        for (let r = b.r0 + 0.4; r < b.r1 && i < p.n; r += 0.85) {
          if (Math.abs(r - g) < b.gw / 2) {
            dummy.scale.setScalar(0.0001);
          } else {
            dummy.scale.setScalar(1 + Math.sin(this.time * 8 + r) * 0.12);
          }
          dummy.position.set(Math.cos(ang) * r, 1 + Math.sin(this.time * 4 + r * 2) * 0.15, Math.sin(ang) * r);
          dummy.updateMatrix();
          p.inst.setMatrixAt(i++, dummy.matrix);
          if (Math.random() < 0.08 && dummy.scale.x > 0.5) this.fx.trail(dummy.position.x, dummy.position.y, dummy.position.z, '#9fe8ff', 0.7, 0.5, 0.2);
        }
        for (; i < p.n; i++) {
          dummy.scale.setScalar(0.0001);
          dummy.updateMatrix();
          p.inst.setMatrixAt(i, dummy.matrix);
        }
        p.inst.instanceMatrix.needsUpdate = true;
        break;
      }
      case 'hill': {
        o.position.x += (x - o.position.x) * Math.min(1, dt * 10);
        o.position.z += (z - o.position.z) * Math.min(1, dt * 10);
        const c = b.o != null ? this.colors[b.o] : '#ffd24a';
        v.parts.ring.material.color.set(c);
        v.parts.fill.material.color.set(c);
        v.parts.beam.material.color.set(c);
        v.parts.beam.material.opacity = 0.1 + Math.sin(this.time * 4) * 0.04;
        break;
      }
      case 'floor':
        break;
      case 'obstacle':
        o.position.set(x, 0, z);
        break;
      default:
        if (v.missile) v.missile.update(x, z, dt, o.visible);
    }
  }

  // Link chains: a scrolling teal energy beam, like WC3's drain lightning.
  updateLinks(b) {
    const links = b.links || [];
    while (this.linkBeams.length < links.length) this.linkBeams.push(this.fx.beam({ color: '#6affd0', width: 0.9, scroll: 3, map: artTexture('fx_lightning_white', undefined, { repeat: true }) }));
    this.linkBeams.forEach((m, i) => {
      const l = links[i];
      const va = l && this.views.get(l[0]);
      const vb = l && this.views.get(l[1]);
      if (!va || !vb) {
        m.mesh.visible = false;
        return;
      }
      m.mesh.visible = true;
      m.set(va.x, 1.2, va.z, vb.x, 1.2, vb.z);
      m.scroll(1 / 60);
      if (Math.random() < 0.4) {
        const t = Math.random();
        this.fx.spark(va.x + (vb.x - va.x) * t, 1.2, va.z + (vb.z - va.z) * t, '#8affd8', 0.55, 0.3, 1);
      }
    });
  }

  // Name and health bars follow their units. DOM writes are skipped when
  // nothing changed, and positions are whole pixels, so a still unit costs
  // the browser nothing.
  positionBars() {
    const v3 = this._barV || (this._barV = new THREE.Vector3());
    for (const v of this.views.values()) {
      if (!v.bar) continue;
      const show = v.visibleBar && v.obj.visible;
      if (show !== v.barShown) {
        v.bar.style.display = show ? '' : 'none';
        v.barShown = show;
      }
      if (!show) continue;
      v3.set(v.obj.position.x, v.obj.position.y + 3.1, v.obj.position.z);
      v3.project(this.camera);
      const t = `translate(-50%, -100%) translate(${Math.round(((v3.x + 1) / 2) * this.width)}px, ${Math.round(((1 - v3.y) / 2) * this.height)}px)`;
      if (t !== v.barT) {
        v.bar.style.transform = t;
        v.barT = t;
      }
    }
  }

  // ------------------------------------------------------------- camera

  myView() {
    return this.myUnit != null ? this.views.get(this.myUnit) : null;
  }

  updateCamera(dt) {
    const me = this.myView();
    if (this.follow && me && !(me.deadT > 1.5)) {
      this.focus.x += (me.obj.position.x - this.focus.x) * Math.min(1, dt * 6);
      this.focus.z += (me.obj.position.z - this.focus.z) * Math.min(1, dt * 6);
    } else if (this.pan) {
      this.focus.x += this.pan.x * dt * this.zoom * 1.2;
      this.focus.z += this.pan.z * dt * this.zoom * 1.2;
    }
    const B = this.map?.bounds ?? 25;
    this.focus.x = Math.max(-B, Math.min(B, this.focus.x));
    this.focus.z = Math.max(-B, Math.min(B, this.focus.z));
    this.camera.position.set(this.focus.x, this.focus.y + Math.sin(CAM_PITCH) * this.zoom, this.focus.z + Math.cos(CAM_PITCH) * this.zoom);
    this.camera.lookAt(this.focus);
    if (this.scene.fog) {
      this.scene.fog.near = this.zoom + 20;
      this.scene.fog.far = this.zoom + 95;
    }
    this.sun.position.set(this.focus.x + 15, 35, this.focus.z + 10);
    this.sun.target.position.copy(this.focus);
  }

  centerOnMe() {
    const me = this.myView();
    if (me) this.focus.set(me.obj.position.x, 0, me.obj.position.z);
  }

  screenToGround(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, p)) return null;
    return { x: p.x, y: p.z };
  }

  showRange(r) {
    const me = this.myView();
    if (!r || !me) {
      this.rangeRing.visible = false;
      return;
    }
    this.rangeRing.visible = true;
    this.rangeRing.position.x = me.obj.position.x;
    this.rangeRing.position.z = me.obj.position.z;
    this.rangeRing.scale.set(r, 1, r);
  }

  // WC3's order confirmation: green arrows around the clicked point that
  // converge and shrink over half a second.
  moveMarker(x, z) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: '#30ff30', transparent: true, depthWrite: false, toneMapped: false });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const pivot = new THREE.Group();
      pivot.rotation.y = -a;
      const arrow = new THREE.Mesh(this.arrowGeo, mat);
      arrow.rotation.y = Math.PI;
      pivot.add(arrow);
      g.add(pivot);
    }
    g.position.set(x, 0.12, z);
    this.scene.add(g);
    this.markers.push({ g, mat, t: 0 });
  }

  updateMarkers(dt) {
    this.markers = this.markers.filter((m) => {
      m.t += dt;
      const k = m.t / 0.5;
      if (k >= 1) {
        this.scene.remove(m.g);
        m.mat.dispose();
        return false;
      }
      const r = 1.3 * (1 - k) + 0.2;
      for (const pivot of m.g.children) {
        pivot.children[0].position.x = r;
        pivot.children[0].scale.setScalar(1 - k * 0.6);
      }
      m.mat.opacity = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      return true;
    });
  }

  showReticle(p, r) {
    this.reticle.visible = !!p;
    if (!p) return;
    this.reticle.position.x = p.x;
    this.reticle.position.z = p.y;
    this.reticle.scale.set(r, 1, r);
  }

  // ------------------------------------------------------------- events

  handleEvent(e) {
    const fx = this.fx;
    switch (e.k) {
      case 'cast': {
        const v = this.views.get(e.u);
        if (v) v.castT = 0.3;
        // The staff flares as the spell leaves it.
        const c = this.spellColors[e.s] || '#fff';
        fx.add.spawn(e.x, 1.6, e.y, 0, 0.3, 0, new THREE.Color(c), 2.2, 0.3, 0, 0, { endScale: 1.5 });
        for (let i = 0; i < 6; i++) fx.spark(e.x, 1.5, e.y, c, 0.6, 0.35, 2);
        play(e.s);
        break;
      }
      case 'boom': {
        // Fire (Fireball, Meteor, a detonated Fireball) explodes in flame, like
        // WC3's fire-lord death explosion; other magic bursts in its colour.
        const c = e.c || '#ff8040';
        const size = e.big ? Math.max(1.4, (e.r || 2) / 1.6) : 0.8;
        if (FIRE_COLORS.has(c)) fx.explosion(e.x, e.y, { size, y: e.big ? 0.6 : 1.1 });
        else {
          fx.magicBurst(e.x, e.big ? 0.8 : 1.1, e.y, c, e.big ? 1.6 : 0.9);
          fx.ring(e.x, e.y, e.r || 1, c, e.big ? 0.6 : 0.35);
        }
        if (e.big) {
          fx.flash(e.x, e.y, e.r || 2, c, 0.4);
          if (e.r) fx.ring(e.x, e.y, e.r, c, 0.6);
          this.shake = 0.35;
        }
        play(e.big ? 'bigboom' : 'hit');
        break;
      }
      case 'fizzle':
        // A missile reaching the end of its range just winks out.
        fx.add.spawn(e.x, 1.1, e.y, 0, 0, 0, new THREE.Color(e.c || '#fff'), 1.8, 0.2, 0, 0, { endScale: 0.2 });
        break;
      case 'bolt':
        fx.bolt(e.x1, e.y1, e.x2, e.y2);
        fx.flash(e.x2, e.y2, 2, '#9fd4ff', 0.2);
        break;
      case 'charge': {
        // A wind-up (Scourge): energy spirals in toward the caster, faster
        // and brighter as the blast nears.
        const v = this.views.get(e.u);
        if (!v) break;
        const c = new THREE.Color(this.spellColors[e.s] || '#c050ff');
        let acc = 0;
        fx.transients.push({ obj: null, t: 0, dur: e.t, update: (k) => {
          if (v.deadT > 0) return;
          acc += 1 + k * 3;
          for (; acc >= 1; acc--) {
            const a = Math.random() * Math.PI * 2;
            const r = 2.6 - k * 1.2;
            fx.add.spawn(v.x + Math.cos(a) * r, 0.4 + Math.random() * 1.4, v.z + Math.sin(a) * r, -Math.cos(a) * r * 3 - Math.sin(a) * 2, 0, -Math.sin(a) * r * 3 + Math.cos(a) * 2, c, 0.5 + k * 0.4, 0.3, 0, 0);
          }
        } });
        break;
      }
      case 'tele':
        for (const [x, z] of [[e.x1, e.y1], [e.x2, e.y2]]) {
          // A blink: a flash of pale blue light and sparkles rising in a column.
          fx.magicBurst(x, 1, z, '#8fb8ff', 0.8);
          for (let i = 0; i < 16; i++) fx.spark(x + (Math.random() - 0.5) * 1, 0.2 + Math.random() * 1.5, z + (Math.random() - 0.5) * 1, '#cfe4ff', 0.6, 0.7, 0.8);
        }
        break;
      case 'dmg':
        fx.text(e.x, 2.2, e.y, String(e.n), '#ff5a5a');
        break;
      case 'txt':
        fx.text(e.x, 2.4, e.y, e.s, e.c || '#fff', true);
        break;
      case 'reflect':
        fx.ring(e.x, e.y, 1.2, '#ffe066', 0.3);
        play('reflect');
        break;
      case 'death':
        fx.explosion(e.x, e.y, { size: 1.3, y: 0.4 });
        for (let i = 0; i < 6; i++) fx.smoke(e.x, 0.5, e.y, '#1a1412', 1.8, 2);
        play('death');
        break;
      case 'zap':
        fx.burst(e.x, 1, e.y, '#9fe8ff', { n: 40, speed: 5, size: 0.6, life: 0.6 });
        fx.flash(e.x, e.y, 2, '#9fe8ff');
        play('zap');
        break;
      case 'squish':
        fx.burst(e.x, 0.3, e.y, '#8a7a60', { n: 30, speed: 4, size: 1, life: 0.8, additive: false });
        play('squish');
        break;
      case 'splash':
        fx.burst(e.x, 0, e.y, '#bfe8ff', { n: 40, speed: 6, size: 0.6, life: 0.8, up: 1.6, grav: 12, additive: false });
        fx.ring(e.x, e.y, 2, '#ffffff', 0.6, -0.3);
        play('splash');
        break;
      case 'shove':
        fx.ring(e.x, e.y, e.r, '#ffe7a0', 0.3);
        fx.burst(e.x, 0.4, e.y, '#ffe7a0', { n: 16, speed: 6, size: 0.5, life: 0.3, up: 0.2 });
        play('shove');
        break;
      case 'sfx':
        play(e.s);
        break;
      case 'err':
        this.onError?.(e.text);
        break;
    }
  }
}

function lerp(a, b, k) {
  return a + (b - a) * k;
}

function lerpAngle(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

function setOpacity(obj, op) {
  if (obj.userData.opacity === op) return;
  obj.userData.opacity = op;
  obj.traverse((o) => {
    if (!o.isMesh || !o.material || o === obj.userData.shieldMesh) return;
    if (!o.userData.ownMat) {
      o.material = o.material.clone();
      o.userData.ownMat = true;
    }
    o.material.transparent = op < 1 || o.material.blending === THREE.AdditiveBlending || o.material.opacity < 1;
    if (!o.userData.baseOpacity) o.userData.baseOpacity = o.material.opacity;
    o.material.opacity = o.userData.baseOpacity * op;
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
