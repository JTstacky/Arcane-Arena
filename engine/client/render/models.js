// Procedural low-poly models in a chunky Warcraft III style. Everything is
// built from primitives so the game needs no model files. Models face +X.

import * as THREE from 'three';

const matCache = new Map();
export function mat(color, opts = {}) {
  const key = new THREE.Color(color).getHexString() + JSON.stringify(opts);
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, flatShading: true, ...opts }));
  }
  return matCache.get(key);
}

export function glowMat(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, toneMapped: false });
}

function mesh(geo, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

const G = {
  sphere: new THREE.SphereGeometry(1, 12, 10),
  sphereLo: new THREE.IcosahedronGeometry(1, 1),
  cone: new THREE.ConeGeometry(1, 1, 10),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 10),
  box: new THREE.BoxGeometry(1, 1, 1),
};

function scaled(geo, sx, sy = sx, sz = sx) {
  const g = geo.clone();
  g.scale(sx, sy, sz);
  return g;
}

function darken(hex, k) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return c;
}

// A robed Blood Elf caster in the Warcraft III style: dark cloth, gold trim,
// team colour on the cloak, hood and tabard (as WC3 team-colours only parts
// of a model), and a staff crowned with a green crystal.
function lathe(points, segs = 12) {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segs);
}

export function warlock(color) {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  const cloth = mat('#2b2230');
  const clothLight = mat('#43344a');
  const team = mat(color);
  const teamDark = mat(darken(color, 0.6));
  const gold = mat('#d8aa3a', { metalness: 0.7, roughness: 0.35 });
  const trimGold = mat('#b88a2a', { metalness: 0.6, roughness: 0.4 });

  // Flared robe down to the ground, with a gold hem.
  const robe = mesh(lathe([[0.001, 1.08], [0.3, 1.02], [0.36, 0.7], [0.46, 0.3], [0.56, 0.04], [0.001, 0.04]]), cloth);
  const hem = mesh(lathe([[0.565, 0.1], [0.58, 0.02], [0.565, 0.0]], 14), trimGold);
  // Team-coloured tabard down the front.
  const tabard = mesh(scaled(G.box, 0.05, 0.78, 0.26), team, 0.42, 0.5, 0);
  tabard.rotation.z = 0.2;
  const tabardTrim = mesh(scaled(G.box, 0.04, 0.8, 0.32), trimGold, 0.41, 0.5, 0);
  tabardTrim.rotation.z = 0.2;
  // Chest and belt.
  const chest = mesh(lathe([[0.001, 1.42], [0.2, 1.4], [0.3, 1.25], [0.28, 1.02], [0.001, 1.0]]), clothLight);
  const belt = mesh(scaled(G.cyl, 0.31, 0.08, 0.31), gold, 0, 1.03, 0);
  const buckle = mesh(scaled(G.box, 0.06, 0.1, 0.12), gold, 0.31, 1.03, 0);
  // Cloak hanging from the shoulders at the back (a partial open cylinder).
  // (Cylinder angle 0 faces +Z, so 1.5 pi is the back, -X.)
  const cloakGeo = new THREE.CylinderGeometry(0.33, 0.6, 1.3, 10, 1, true, Math.PI * 1.1, Math.PI * 0.8);
  const cloak = mesh(cloakGeo, new THREE.MeshStandardMaterial({ color, roughness: 0.8, flatShading: true, side: THREE.DoubleSide }), -0.05, 0.72, 0);
  // Big pointed shoulder guards, as WC3 heroes wear them.
  const pads = [];
  for (const s of [1, -1]) {
    const pad = mesh(scaled(G.sphere, 0.2, 0.13, 0.22), gold, 0, 1.36, 0.3 * s);
    const spike = mesh(scaled(G.cone, 0.07, 0.3, 0.07), teamDark, 0, 1.5, 0.36 * s);
    spike.rotation.x = -0.5 * s;
    // Sleeve hanging from the shoulder.
    const sleeve = mesh(scaled(G.cone, 0.14, 0.55, 0.14), cloth, 0.08, 1.12, 0.33 * s);
    sleeve.rotation.x = Math.PI;
    sleeve.rotation.z = -0.35;
    const hand = mesh(scaled(G.sphere, 0.07), mat('#e7c6a2'), 0.2, 0.86, 0.36 * s);
    pads.push(pad, spike, sleeve, hand);
  }
  // Head in a deep team-coloured hood; the face is in shadow but for the eyes.
  const face = mesh(scaled(G.sphere, 0.16, 0.18, 0.16), mat('#16101a'), 0.06, 1.58, 0);
  const hood = mesh(lathe([[0.001, 1.98], [0.1, 1.86], [0.22, 1.7], [0.24, 1.52], [0.2, 1.4], [0.001, 1.4]], 10), team);
  hood.position.x = -0.04;
  hood.rotation.z = 0.12;
  const ears = [];
  for (const s of [1, -1]) {
    // Long Blood Elf ears poking through the hood.
    const ear = mesh(scaled(G.cone, 0.035, 0.28, 0.02), mat('#e7c6a2'), 0.0, 1.62, 0.24 * s);
    ear.rotation.x = -1.15 * s;
    ears.push(ear);
  }
  const eyeL = mesh(scaled(G.sphere, 0.03), glowMat('#8dff6a'), 0.2, 1.6, 0.06);
  const eyeR = mesh(scaled(G.sphere, 0.03), glowMat('#8dff6a'), 0.2, 1.6, -0.06);

  // The staff: dark wood, a gold collar and three prongs cradling the crystal.
  const staff = new THREE.Group();
  staff.position.set(0.22, 0.9, -0.4);
  const wood = mat('#3a2616');
  staff.add(mesh(scaled(G.cyl, 0.035, 2.0, 0.035), wood, 0, 0.1, 0));
  staff.add(mesh(scaled(G.cyl, 0.06, 0.1, 0.06), gold, 0, 0.95, 0));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const prong = mesh(scaled(G.cone, 0.03, 0.34, 0.03), gold, Math.cos(a) * 0.09, 1.14, Math.sin(a) * 0.09);
    prong.rotation.set(Math.sin(a) * 0.45, 0, -Math.cos(a) * 0.45);
    staff.add(prong);
  }
  const orb = mesh(new THREE.OctahedronGeometry(0.12, 0), glowMat('#8dff6a'), 0, 1.15, 0);
  orb.scale.y = 1.5;
  staff.add(orb);
  const ferrule = mesh(scaled(G.cone, 0.04, 0.14, 0.04), gold, 0, -0.96, 0);
  ferrule.rotation.x = Math.PI;
  staff.add(ferrule);

  body.add(robe, hem, tabard, tabardTrim, chest, belt, buckle, cloak, ...pads, face, hood, ...ears, eyeL, eyeR, staff);
  g.userData = { body, staff, orb, kind: 'hero' };
  return g;
}

// A paladin in plate with a warhammer and a team-coloured tabard.
export function paladin(color) {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  const steel = mat('#b8bcc6', { metalness: 0.6, roughness: 0.35 });
  const gold = mat('#d8a834', { metalness: 0.7, roughness: 0.3 });
  const legL = mesh(scaled(G.cyl, 0.12, 0.55, 0.12), steel, 0, 0.28, 0.14);
  const legR = mesh(scaled(G.cyl, 0.12, 0.55, 0.12), steel, 0, 0.28, -0.14);
  const torso = mesh(scaled(G.box, 0.42, 0.6, 0.55), steel, 0, 0.85, 0);
  const tabard = mesh(scaled(G.box, 0.05, 0.75, 0.34), mat(color), 0.23, 0.75, 0);
  const belt = mesh(scaled(G.box, 0.45, 0.08, 0.58), gold, 0, 0.58, 0);
  const head = mesh(scaled(G.sphere, 0.19), mat('#d9b08c'), 0.03, 1.33, 0);
  const helm = mesh(scaled(G.sphere, 0.21, 0.16, 0.21), steel, 0, 1.43, 0);
  const plume = mesh(scaled(G.cone, 0.06, 0.3, 0.06), mat(color), -0.05, 1.62, 0);
  const pauldL = mesh(scaled(G.sphere, 0.2, 0.15, 0.2), gold, 0, 1.12, 0.33);
  const pauldR = mesh(scaled(G.sphere, 0.2, 0.15, 0.2), gold, 0, 1.12, -0.33);
  const hammer = new THREE.Group();
  hammer.position.set(0.15, 0.9, -0.42);
  hammer.add(mesh(scaled(G.cyl, 0.035, 1.1, 0.035), mat('#6b4a2a'), 0, 0.2, 0));
  hammer.add(mesh(scaled(G.box, 0.22, 0.2, 0.36), gold, 0, 0.75, 0));
  hammer.rotation.z = -0.3;
  body.add(legL, legR, torso, tabard, belt, head, helm, plume, pauldL, pauldR, hammer);
  g.userData = { body, staff: hammer, legL, legR, kind: 'hero' };
  return g;
}

export function kodo() {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  const hide = mat('#8a6a4a');
  const belly = mesh(scaled(G.sphereLo, 1.2, 0.85, 0.85), hide, 0, 1.1, 0);
  const head = mesh(scaled(G.sphereLo, 0.55, 0.45, 0.5), mat('#9a7a58'), 1.2, 1.0, 0);
  const jaw = mesh(scaled(G.box, 0.5, 0.2, 0.5), mat('#6a4a30'), 1.45, 0.75, 0);
  const hornL = mesh(scaled(G.cone, 0.1, 0.5, 0.1), mat('#eee6d0'), 1.4, 1.35, 0.3);
  const hornR = mesh(scaled(G.cone, 0.1, 0.5, 0.1), mat('#eee6d0'), 1.4, 1.35, -0.3);
  hornL.rotation.x = -0.6;
  hornR.rotation.x = 0.6;
  const legs = [];
  for (const [x, z] of [[0.6, 0.5], [0.6, -0.5], [-0.6, 0.5], [-0.6, -0.5]]) {
    const l = mesh(scaled(G.cyl, 0.2, 0.7, 0.2), hide, x, 0.35, z);
    legs.push(l);
    body.add(l);
  }
  const drum = mesh(scaled(G.cyl, 0.35, 0.4, 0.35), mat('#b33a2a'), -0.3, 2.0, 0);
  body.add(belly, head, jaw, hornL, hornR, drum);
  g.userData = { body, legs, kind: 'beast' };
  return g;
}

export function golem() {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  const flesh = mat('#8fae6e');
  const torso = mesh(scaled(G.sphereLo, 0.8, 0.9, 0.9), flesh, 0, 1.3, 0);
  const gut = mesh(scaled(G.sphereLo, 0.7, 0.6, 0.75), mat('#a3c07e'), 0.25, 0.9, 0);
  const head = mesh(scaled(G.sphereLo, 0.3), flesh, 0.5, 2.0, 0);
  const armL = mesh(scaled(G.cyl, 0.22, 1.1, 0.22), flesh, 0.2, 1.0, 0.95);
  const armR = mesh(scaled(G.cyl, 0.22, 1.1, 0.22), flesh, 0.2, 1.0, -0.95);
  const cleaver = mesh(scaled(G.box, 0.6, 0.1, 0.4), mat('#999', { metalness: 0.6 }), 0.5, 0.5, -1.0);
  const stitch = mesh(scaled(G.box, 0.05, 0.8, 0.06), mat('#402020'), 0.78, 1.2, 0);
  body.add(torso, gut, head, armL, armR, cleaver, stitch);
  g.userData = { body, kind: 'beast' };
  return g;
}

export function coin() {
  const g = new THREE.Group();
  const c = mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.08, 16), mat('#ffcc33', { metalness: 0.9, roughness: 0.25, emissive: '#553300' }), 0, 0.6, 0);
  c.rotation.x = Math.PI / 2;
  g.add(c);
  g.userData = { spin: c };
  return g;
}

export function goldbag() {
  const g = new THREE.Group();
  const sack = mesh(scaled(G.sphereLo, 0.5, 0.45, 0.5), mat('#9a7040'), 0, 0.45, 0);
  const tie = mesh(scaled(G.cone, 0.2, 0.3, 0.2), mat('#7a5030'), 0, 0.95, 0);
  const gl = mesh(scaled(G.sphere, 0.18), mat('#ffd24a', { metalness: 0.9, emissive: '#664400' }), 0.2, 0.8, 0.15);
  g.add(sack, tie, gl);
  g.userData = { spin: g };
  return g;
}

export function tree(s = 1) {
  const g = new THREE.Group();
  g.add(mesh(scaled(G.cyl, 0.18 * s, 1.2 * s, 0.18 * s), mat('#5b3d22'), 0, 0.6 * s, 0));
  const leaf = mat('#2f5a2a');
  const leaf2 = mat('#3b6e30');
  g.add(mesh(scaled(G.cone, 1.1 * s, 1.6 * s, 1.1 * s), leaf, 0, 1.7 * s, 0));
  g.add(mesh(scaled(G.cone, 0.85 * s, 1.4 * s, 0.85 * s), leaf2, 0, 2.4 * s, 0));
  g.add(mesh(scaled(G.cone, 0.55 * s, 1.1 * s, 0.55 * s), leaf, 0, 3.0 * s, 0));
  g.rotation.y = Math.random() * 6;
  return g;
}

export function snowTree(s = 1) {
  const g = tree(s);
  g.children.slice(1).forEach((m) => (m.material = mat('#dfe9f2')));
  return g;
}

export function rock(s = 1) {
  const m = mesh(new THREE.DodecahedronGeometry(s, 0), mat('#6d6a66'), 0, s * 0.4, 0);
  m.scale.y = 0.7;
  m.rotation.set(Math.random(), Math.random() * 6, Math.random());
  const g = new THREE.Group();
  g.add(m);
  return g;
}

export function pillar(s = 1) {
  const g = new THREE.Group();
  const stone = mat('#a8a294');
  g.add(mesh(scaled(G.box, 0.9 * s, 0.3, 0.9 * s), stone, 0, 0.15, 0));
  g.add(mesh(scaled(G.cyl, 0.3 * s, 2.6 * s, 0.3 * s), stone, 0, 1.4 * s, 0));
  g.add(mesh(scaled(G.box, 0.8 * s, 0.25, 0.8 * s), stone, 0, 2.8 * s, 0));
  return g;
}

export function torch() {
  const g = new THREE.Group();
  g.add(mesh(scaled(G.cyl, 0.06, 1.4, 0.06), mat('#4a3322'), 0, 0.7, 0));
  g.add(mesh(scaled(G.cyl, 0.15, 0.15, 0.15), mat('#333'), 0, 1.45, 0));
  const flame = mesh(scaled(G.cone, 0.14, 0.4, 0.14), glowMat('#ffaa33'), 0, 1.7, 0);
  flame.castShadow = false;
  g.add(flame);
  g.userData = { flame };
  return g;
}

export function moonwell() {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(2.1, 2.3, 0.7, 20), mat('#8d8aa8'), 0, 0.35, 0));
  const water = mesh(new THREE.CylinderGeometry(1.8, 1.8, 0.1, 20), glowMat('#5fd0ff', 0.9), 0, 0.72, 0);
  g.add(water);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.add(mesh(scaled(G.cone, 0.18, 1.2, 0.18), mat('#b7b3d6'), Math.cos(a) * 2.05, 1.1, Math.sin(a) * 2.05));
  }
  return g;
}

export function goldmine() {
  const g = new THREE.Group();
  g.add(mesh(scaled(G.sphereLo, 2.4, 1.6, 2), mat('#7d6b55'), 0, 0.6, 0));
  g.add(mesh(scaled(G.box, 1.2, 1.3, 0.4), mat('#1d140c'), 0, 0.8, -1.8));
  for (let i = 0; i < 5; i++) g.add(mesh(scaled(G.sphereLo, 0.3), mat('#ffcc33', { metalness: 0.9, emissive: '#443300' }), (Math.random() - 0.5) * 3, 1.6 + Math.random() * 0.5, (Math.random() - 0.5) * 2));
  return g;
}

export function flag() {
  const g = new THREE.Group();
  g.add(mesh(scaled(G.cyl, 0.05, 2.6, 0.05), mat('#ddd'), 0, 1.3, 0));
  const cloth = mesh(scaled(G.box, 0.9, 0.55, 0.03), mat('#e0c030'), 0.45, 2.3, 0);
  g.add(cloth);
  g.userData = { cloth };
  return g;
}

export function lavaRock(s = 1) {
  const g = rock(s);
  g.children[0].material = mat('#2a2220');
  return g;
}
