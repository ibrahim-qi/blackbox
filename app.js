/* blackbox v0.1 — a flight data recorder for humans
   live: iphone gps + gyros + accelerometer  ·  demo: scripted flight
   fully offline — the phone never talks to the internet. */

'use strict';

/* ---------------- elements ---------------- */
const $ = id => document.getElementById(id);
const H = {
  status: $('status'), pos: $('pos'),
  gs: $('gs'), alt: $('alt'), oat: $('oat'), wind: $('wind'),
  gscap: $('gscap'), altcap: $('altcap'), oatcap: $('oatcap'), windcap: $('windcap'),
  narr: $('narr'),
  gl: $('gl'),
  overlay: $('overlay'), osub: $('osub'), start: $('start'), demo: $('demo'), reset: $('reset')
};

/* ---------------- state ---------------- */
const S = {
  mode: 'idle',            // idle | demo | armed | flying | landed
  t0: null,                // demo start (performance.now)
  flightT: 0,              // flight time, s
  gs: 0, alt: 0, vs: 0,    // m/s, m, m/s
  pitch: 0, roll: 0,       // deg
  heading: 0,              // rad, true north clockwise
  mach: 0, oatC: 15, windKt: 0,
  lat: null, lng: null, fix: false, fixAcc: null,
  samples: [], altHist: [], maxAlt: 0, maxGs: 0, startedAt: null
};

const MS2KT = 1.9438445, M2FT = 3.2808399, MS2FPM = 196.85039;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const group = n => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const fmtT = s => { s = Math.max(0, s | 0); const m = (s / 60) | 0, r = s % 60; return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r; };
const fmtLat = v => Math.abs(v).toFixed(2) + '°' + (v >= 0 ? 'N' : 'S');
const fmtLng = v => Math.abs(v).toFixed(2) + '°' + (v >= 0 ? 'E' : 'W');
const fmtEta = s => { s = Math.max(0, s | 0); const h = (s / 3600) | 0, m = Math.round((s % 3600) / 60); return h ? h + 'h ' + m + 'm' : m + 'm'; };

/* ---------------- atmosphere model (ISA) ---------------- */
function isa(altM) {
  const T = altM < 11000 ? 288.15 - 0.0065 * altM : 216.65;   // kelvin
  return { T, a: 340.294 * Math.sqrt(T / 288.15) };           // a = speed of sound, m/s
}

/* ---------------- demo flight (1 demo s = 1 real flight min) ---------------- */
const DEMO_T = 301;
const BRS = { lat: 51.3827, lng: -2.7191 }, SVQ = { lat: 37.418, lng: -5.8988 };
/* the real flight — update dep/durMin from the boarding pass if they differ */
const FLIGHT = { cs: 'EZY2899', from: 'BRS', to: 'SVQ', aircraft: 'A320', dep: '16:40', durMin: 140 };

function liveEta() {
  const dep = new Date('2026-08-18T16:40:00+01:00').getTime();   // 16:40 BST
  return Math.max(0, (dep + FLIGHT.durMin * 60000 - Date.now()) / 1000);
}

/* dead reckoning — position along the planned route when GPS drops out */
function deadReckon() {
  const f = clamp(S.flightT / (FLIGHT.durMin * 60), 0, 1);
  S.lat = BRS.lat + (SVQ.lat - BRS.lat) * f;
  S.lng = BRS.lng + (SVQ.lng - BRS.lng) * f - 0.8 * Math.sin(Math.PI * f);
}

function demoStep(t) {
  const o = { gs: 0, alt: 0, vs: 0, pitch: 0, roll: 0, mach: .78, windKt: 0, lat: BRS.lat, lng: BRS.lng, eta: DEMO_T - t };
  if (t < 40) {                                   // takeoff roll
    o.gs = 1.8 * t;
  } else if (t < 54) {                            // rotation + liftoff
    const f = (t - 40) / 14;
    o.gs = 72 + 6 * f; o.vs = 12.7 * f; o.alt = 89 * f; o.pitch = 15 * f; o.mach = .74; o.windKt = 5 * f;
  } else if (t < 200) {                           // climb to cruise
    const f = (t - 54) / 146;
    o.alt = 89 + (10668 - 89) * f; o.vs = 12.7;
    o.gs = 150 + 55 * f; o.pitch = 15 - 12.5 * f; o.mach = .72; o.windKt = -15 + 25 * f;
  } else if (t < 275) {                           // cruise
    o.alt = 10668; o.gs = 265; o.pitch = 2.5; o.mach = .77; o.vs = 0; o.windKt = 68;
    if (t > 210 && t < 216) o.roll = 20;
    if (t > 240 && t < 246) o.roll = -20;
  } else if (t < 289) {                           // descent
    const f = (t - 275) / 14;
    o.alt = 10668 * (1 - f); o.gs = 265 - 193 * f; o.vs = -11; o.pitch = -3; o.mach = .72; o.windKt = 68 - 38 * f;
  } else {                                        // flare + rollout
    const f = (t - 289) / 12;
    o.alt = 0; o.gs = 72 * (1 - f); o.pitch = 3 * (1 - f); o.vs = 0; o.mach = .72; o.windKt = 30 * (1 - f);
  }
  const f = clamp(t / DEMO_T, 0, 1);
  o.lat = BRS.lat + (SVQ.lat - BRS.lat) * f;
  o.lng = BRS.lng + (SVQ.lng - BRS.lng) * f - 0.8 * Math.sin(Math.PI * f);
  return o;
}

/* ---------------- sensors (live) ---------------- */
const FUSE = { pitch: 0, roll: 0, last: null, init: false };
const DBG = { ax: 0, ay: 0, az: 0, ry: 0, rz: 0 };

window.addEventListener('devicemotion', e => {
  const g = e.accelerationIncludingGravity, r = e.rotationRate;
  if (!g) return;
  DBG.ax = g.x; DBG.ay = g.y; DBG.az = g.z;
  if (r) { DBG.ry = r.beta; DBG.rz = r.gamma; }
  const now = performance.now();
  const dt = FUSE.last ? clamp((now - FUSE.last) / 1000, 0, .25) : 0;
  FUSE.last = now;

  /* phone flat on tray, top edge = nose, screen up:
     pitch = rotation about x, + = nose up  → rate = +rotationRate.beta
     roll  = rotation about y, + = bank right → rate = +rotationRate.gamma
     (signs verified on device; flip here if inverted) */
  if (!FUSE.init) {
    FUSE.pitch = Math.atan2(g.y, g.z) * 180 / Math.PI;
    FUSE.roll = Math.atan2(-g.x, g.z) * 180 / Math.PI;
    FUSE.init = true;
  } else {
    if (r) { FUSE.pitch += r.beta * dt; FUSE.roll += r.gamma * dt; }
    const mag = Math.hypot(g.x, g.y, g.z);
    if (Math.abs(mag - 9.81) < 2) {              // only trust gravity when roughly steady
      const pA = Math.atan2(g.y, g.z) * 180 / Math.PI;
      const rA = Math.atan2(-g.x, g.z) * 180 / Math.PI;
      FUSE.pitch = .98 * FUSE.pitch + .02 * pA;
      FUSE.roll = .98 * FUSE.roll + .02 * rA;
    }
  }
  if (S.mode === 'flying' || S.mode === 'armed') { S.pitch = FUSE.pitch; S.roll = FUSE.roll; }
});

function armGPS() {
  navigator.geolocation.watchPosition(p => {
    S.fix = true;
    S.fixAcc = p.coords.accuracy;
    S.lat = p.coords.latitude; S.lng = p.coords.longitude;
    if (p.coords.altitude != null) S.alt = p.coords.altitude;
    if (p.coords.speed != null) S.gs = p.coords.speed;
    if (p.coords.heading != null) S.heading = p.coords.heading * Math.PI / 180;
  }, () => { S.fix = false; S.fixAcc = null; },
  { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
}

/* ---------------- derived values (live) ---------------- */
function liveDerived() {
  const { T, a } = isa(S.alt);
  S.oatC = T - 273.15;
  const mach = S.vs > 3 ? .74 : S.vs < -3 ? .72 : .78;
  S.mach = S.gs > 30 ? mach : 0;
  S.windKt = S.gs * MS2KT - mach * a / 0.514444;
}

/* ---------------- flight state + recorder ---------------- */
let lastTickAlt = null, lastTickT = null, vsEma = 0;

function recordSample() {
  S.samples.push({ t: S.flightT, lat: S.lat, lng: S.lng, alt: S.alt, gs: S.gs, vs: S.vs,
                   pitch: S.pitch, roll: S.roll, mach: S.mach, wind: S.windKt, oat: S.oatC });
  S.altHist.push(S.alt);
  if (S.altHist.length > 1200) S.altHist.shift();
  if (S.alt > S.maxAlt) S.maxAlt = S.alt;
  if (S.gs * MS2KT > S.maxGs) S.maxGs = S.gs * MS2KT;
  if (S.samples.length % 10 === 0) {
    try { localStorage.setItem('blackbox_log', JSON.stringify({ startedAt: S.startedAt, samples: S.samples })); } catch (e) {}
  }
}

function land() {
  S.mode = 'landed';
  try {
    localStorage.setItem('blackbox_summary', JSON.stringify({
      endedAt: Date.now(), flightT: S.flightT, maxAlt: S.maxAlt,
      maxGs: S.maxGs, samples: S.samples.length
    }));
  } catch (e) {}
  showOverlay('complete',
    'T+' + fmtT(S.flightT) + ' &middot; max ' + (S.maxAlt / 1000).toFixed(1) + ' km &middot; ' +
    group(S.maxGs * 1.852) + ' km/h &middot; ' + S.samples.length + ' samples &middot; full report at the gate', true);
}

setInterval(() => {
  if (S.mode === 'demo') {
    const t = (performance.now() - S.t0) / 1000;
    if (t >= DEMO_T) { land(); return; }
    const o = demoStep(t);
    Object.assign(S, o);
    S.flightT = t;
    S.oatC = isa(S.alt).T - 273.15;
    recordSample();
  } else if (S.mode === 'armed' || S.mode === 'flying') {
    if (!S.fix) {
      if (S.mode === 'flying') { deadReckon(); S.flightT += 1; recordSample(); }
      return;
    }
    const now = performance.now();
    if (lastTickT != null && lastTickAlt != null) {
      const dt = (now - lastTickT) / 1000;
      if (dt > 0) {
        const raw = (S.alt - lastTickAlt) / dt;
        vsEma = vsEma === 0 ? raw : .8 * vsEma + .2 * raw;
        S.vs = vsEma;
      }
    }
    lastTickAlt = S.alt; lastTickT = now;
    liveDerived();
    if (S.mode === 'armed' && S.gs * MS2KT > 80 && S.alt > 60) {
      S.mode = 'flying'; S.flightT = 0; S.startedAt = Date.now();
      S.samples = []; S.altHist = []; S.maxAlt = 0; S.maxGs = 0; vsEma = 0;
    }
    if (S.mode === 'flying') {
      S.flightT += 1;
      recordSample();
      if (S.flightT > 60 && S.gs * MS2KT < 25 && S.alt < 150) land();
    }
  }
}, 1000);

/* ---------------- render ---------------- */

/* ---------------- 3d chase view (fully offline) ---------------- */
const DEMO_CITIES = [
  ['plymouth', 50.3714, -4.1422],
  ['santander', 43.4623, -3.81],
  ['salamanca', 40.9701, -5.6635],
  ['seville', 37.3891, -5.9845]
];

/* local tangent plane: metres east/north of the anchor point */
const toXY = (lat, lng) => {
  const lat0 = S.mode === 'demo' ? BRS.lat : S.lat, lng0 = S.mode === 'demo' ? BRS.lng : S.lng;
  return [(lng - lng0) * Math.cos(lat0 * Math.PI / 180) * 111320, (lat - lat0) * 110540];
};

/* baked sky — typical traffic on the corridor, clearly not live */
const TRAFFIC = [
  { cs: 'EZY8342', a: [48.9, 2.2], b: [41.2, -3.1], alt: 11800, gs: 235, t0: 0.02 },
  { cs: 'RYR6134', a: [47.2, -0.5], b: [39.9, -4.8], alt: 11300, gs: 240, t0: 0.10 },
  { cs: 'BAW485', a: [50.3, 0.5], b: [38.5, -5.9], alt: 12000, gs: 250, t0: 0.22 },
  { cs: 'IBE3192', a: [40.4, -5.0], b: [49.5, 1.0], alt: 11600, gs: 245, t0: 0.35 },
  { cs: 'VLG7241', a: [38.8, -6.2], b: [47.0, -1.5], alt: 10900, gs: 230, t0: 0.50 },
  { cs: 'EXS530', a: [45.5, 1.5], b: [39.0, -4.2], alt: 12400, gs: 255, t0: 0.65 },
  { cs: 'AEA1045', a: [42.0, -3.5], b: [49.0, 2.0], alt: 11500, gs: 240, t0: 0.80 },
  { cs: 'WZZ8022', a: [44.5, -2.0], b: [38.2, -6.4], alt: 11200, gs: 235, t0: 0.92 }
];

function trafficPos(fl, t) {
  const elapsed = (t - fl.t0 * DEMO_T) * 30;      // 1 demo s = 30 real s
  if (elapsed < 0) return null;
  const a = toXY(fl.a[0], fl.a[1]), b = toXY(fl.b[0], fl.b[1]);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const f = clamp(elapsed * fl.gs / len, 0, 1);
  if (f >= 1) return null;
  return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, alt: fl.alt, cs: fl.cs };
}

let lastTrafficSaid = 0;
function nearTrafficString() {
  if (S.mode !== 'demo') return '';
  const now = performance.now();
  if (now - lastTrafficSaid < 45000) return '';
  const t = S.flightT;
  const psi = bearing(demoStep(Math.max(0, t - 0.5)), demoStep(t + 0.5));
  const fw = [Math.sin(psi), Math.cos(psi)];
  const p0 = toXY(S.lat, S.lng);
  let best = null;
  for (const fl of TRAFFIC) {
    const q = trafficPos(fl, t);
    if (!q) continue;
    const d = Math.hypot(q.x - p0[0], q.y - p0[1]);
    if (d < 15000 && (!best || d < best.d)) best = { d, q };
  }
  if (!best) return '';
  const dx = best.q.x - p0[0], dy = best.q.y - p0[1];
  const side = fw[0] * dy - fw[1] * dx > 0 ? 'left' : 'right';
  const rel = Math.round(best.q.alt - S.alt);
  lastTrafficSaid = now;
  return 'Another plane passes ' + Math.round(best.d / 1000) + ' km to our ' + side +
    (Math.abs(rel) > 300 ? (rel > 0 ? ', ' + group(Math.abs(rel)) + ' m above' : ', ' + group(Math.abs(rel)) + ' m below') : '') + '. ';
}

const norm3 = v => { const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / m, v[1] / m, v[2] / m]; };
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function bearing(a, b) {
  const f1 = a.lat * Math.PI / 180, f2 = b.lat * Math.PI / 180;
  const dl = (b.lng - a.lng) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return Math.atan2(y, x);
}

/* text sprite from a canvas — labels that live in the 3d world */
function makeLabel(text, scale) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const x = c.getContext('2d');
  x.font = '30px ui-monospace, Menlo, Consolas, monospace';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillStyle = 'rgba(230,225,214,.6)';
  x.fillText(text.toUpperCase(), 256, 62);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, fog: false }));
  sp.scale.set(scale || 3600, (scale || 3600) / 4, 1);
  return sp;
}

/* sun position — the shading on the plane matches the real sun */
function sunDir() {
  const lat = S.lat * Math.PI / 180, lng = S.lng * Math.PI / 180;
  const now = new Date();
  const doy = (now - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400000;
  const decl = -23.44 * Math.cos(2 * Math.PI * (doy + 10) / 365) * Math.PI / 180;
  const solarTime = now.getUTCHours() + now.getUTCMinutes() / 60 + lng * 12 / Math.PI;
  const ha = (solarTime - 12) * 15 * Math.PI / 180;
  const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const el = Math.asin(sinEl);
  const cosAz = (Math.sin(decl) - Math.sin(lat) * sinEl) / (Math.cos(lat) * Math.cos(el));
  const az = Math.acos(clamp(cosAz, -1, 1));
  const azimuth = Math.sin(ha) > 0 ? az : -az;              // east positive
  return new THREE.Vector3(Math.cos(el) * Math.sin(azimuth), Math.sin(el), -Math.cos(el) * Math.cos(azimuth));
}

/* the plane — a low-poly a320 built from geometry, nose +Z, wings ±X, up +Y */
function buildPlane() {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x26272b, flatShading: true, side: THREE.DoubleSide });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xffb454, transparent: true, opacity: .5 });

  const add = (geo, x, y, z, rx, ry, rz) => {
    const grp = new THREE.Group();
    grp.add(new THREE.Mesh(geo, bodyMat));
    grp.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat.clone()));
    grp.position.set(x, y, z);
    if (rx) grp.rotation.x = rx;
    if (ry) grp.rotation.y = ry;
    if (rz) grp.rotation.z = rz;
    g.add(grp);
    return grp;
  };

  /* fuselage: tube, nose cone, tail taper */
  add(new THREE.CylinderGeometry(1.9, 1.9, 26, 12), 0, 0, 2, Math.PI / 2);
  add(new THREE.ConeGeometry(1.9, 7, 12), 0, 0, 16.5, Math.PI / 2);
  add(new THREE.CylinderGeometry(1.0, 1.9, 8, 12), 0, 0, -13, Math.PI / 2);

  /* wings — swept, tapered, low-mounted */
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0.5);
  wingShape.lineTo(5.2, 0);
  wingShape.lineTo(15.5, -1.6);
  wingShape.lineTo(15.5, -0.2);
  wingShape.closePath();
  const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: .3, bevelEnabled: false });
  wingGeo.rotateX(-Math.PI / 2);
  add(wingGeo, 0, -1.3, 6);
  const wingL = add(wingGeo.clone(), 0, -1.3, 6);
  wingL.scale.x = -1;

  /* tailplane */
  const tailShape = new THREE.Shape();
  tailShape.moveTo(0, 0.2);
  tailShape.lineTo(3.2, 0);
  tailShape.lineTo(6.2, -0.6);
  tailShape.lineTo(6.2, 0.2);
  tailShape.closePath();
  const tailGeo = new THREE.ExtrudeGeometry(tailShape, { depth: .2, bevelEnabled: false });
  tailGeo.rotateX(-Math.PI / 2);
  add(tailGeo, 0, 0.7, -15.5);
  const tailL = add(tailGeo.clone(), 0, 0.7, -15.5);
  tailL.scale.x = -1;

  /* fin */
  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0);
  finShape.lineTo(5.2, 0);
  finShape.lineTo(1.2, 7.5);
  finShape.closePath();
  const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: .2, bevelEnabled: false });
  finGeo.rotateY(Math.PI / 2);
  add(finGeo, 0, 0, -16.5);

  /* engines under the wings */
  const engGeo = new THREE.CylinderGeometry(1.05, 1.05, 3.4, 12);
  add(engGeo, 5.6, -2.2, 4.5, Math.PI / 2);
  add(engGeo, -5.6, -2.2, 4.5, Math.PI / 2);

  return g;
}

let GL = null;

function glInit() {
  const cv = H.gl;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h || typeof THREE === 'undefined') return false;
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050505);
  scene.fog = new THREE.Fog(0x050505, 60000, 280000);
  const camera = new THREE.PerspectiveCamera(55, w / h, 1, 500000);
  scene.add(new THREE.AmbientLight(0xffffff, .6));
  const sun = new THREE.DirectionalLight(0xffffff, .9);
  sun.position.set(-30000, 40000, -20000);
  scene.add(sun);

  const plane = buildPlane();
  plane.rotation.order = 'YXZ';
  scene.add(plane);

  scene.add(new THREE.GridHelper(24000, 24, 0x221f1a, 0x17150f));

  /* planned route, always visible */
  const routePts = [];
  for (let i = 0; i <= 80; i++) {
    const f = i / 80;
    const lat = BRS.lat + (SVQ.lat - BRS.lat) * f;
    const lng = BRS.lng + (SVQ.lng - BRS.lng) * f - 0.8 * Math.sin(Math.PI * f);
    const xy = toXY(lat, lng);
    routePts.push(new THREE.Vector3(xy[0], 0, -xy[1]));
  }
  scene.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(routePts),
    new THREE.LineBasicMaterial({ color: 0xffb454, transparent: true, opacity: .22 })
  ));

  /* cities on the corridor */
  for (const c of DEMO_CITIES) {
    const xy = toXY(c[1], c[2]);
    const sp = makeLabel(c[0], 3600);
    sp.position.set(xy[0], 90, -xy[1]);
    scene.add(sp);
  }

  /* traffic dots + labels */
  const dots = TRAFFIC.map(() => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(110, 8, 8), new THREE.MeshBasicMaterial({ color: 0x7a756c }));
    m.visible = false;
    scene.add(m);
    return m;
  });
  const labs = TRAFFIC.map(() => {
    const sp = makeLabel('', 2600);
    sp.visible = false;
    scene.add(sp);
    return sp;
  });

  /* altitude hairline, updated in place */
  const hair = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: 0xe6e1d6, transparent: true, opacity: .12 })
  );
  scene.add(hair);

  GL = { renderer, scene, camera, plane, dots, labs, hair, cam: null, sun };
  return true;
}

function draw3D() {
  if (!GL && !glInit()) return;
  const cv = H.gl;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  const dpr = GL.renderer.getPixelRatio();
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr))
    GL.renderer.setSize(w, h, false);
  const cam = GL.camera;
  if (cam.aspect !== w / h) { cam.aspect = w / h; cam.updateProjectionMatrix(); }

  let psi;
  if (S.mode === 'demo') psi = bearing(demoStep(Math.max(0, S.flightT - 0.5)), demoStep(S.flightT + 0.5));
  else psi = S.heading || 0;

  const p0 = toXY(S.lat, S.lng);
  const P = new THREE.Vector3(p0[0], S.alt, -p0[1]);
  const fw = [Math.sin(psi), -Math.cos(psi)];

  const pl = GL.plane;
  pl.position.copy(P);
  pl.rotation.y = Math.PI - psi;
  pl.rotation.x = -S.pitch * Math.PI / 180;
  pl.rotation.z = -S.roll * Math.PI / 180;

  /* cinematic chase cam — behind and above, softly damped */
  const D = 150, CH = 45, LT = 60;
  const eye = new THREE.Vector3(P.x - fw[0] * D, P.y + CH, P.z - fw[1] * D);
  if (!GL.cam) GL.cam = eye.clone();
  GL.cam.lerp(eye, .14);
  cam.position.copy(GL.cam);
  cam.lookAt(P.x + fw[0] * LT, P.y, P.z + fw[1] * LT);

  /* shade the plane with the real sun */
  GL.sun.position.copy(sunDir().multiplyScalar(40000));

  /* typical traffic */
  if (S.mode === 'demo') {
    const t = S.flightT;
    let n = 0;
    TRAFFIC.forEach((fl, i) => {
      const q = trafficPos(fl, t);
      const dot = GL.dots[i], lab = GL.labs[i];
      if (!q) { dot.visible = lab.visible = false; return; }
      n++;
      const hd = Math.hypot(q.x - p0[0], q.y - p0[1]);
      const near = hd < 20000;
      dot.visible = lab.visible = true;
      dot.position.set(q.x, q.alt, -q.y);
      dot.material.color.setHex(near ? 0xffb454 : 0x7a756c);
      lab.position.set(q.x, q.alt + 420, -q.y);
      const text = q.cs + (near ? ' · ' + (q.alt >= S.alt ? '+' : '−') + Math.round(Math.abs(q.alt - S.alt)) + ' m' : '');
      if (lab._t !== text) {
        lab.material.map = makeLabel(text, 2600).material.map;
        lab.material.needsUpdate = true;
        lab._t = text;
      }
      lab.material.opacity = near ? .85 : .35;
    });
    S.trafficN = n;
  } else {
    GL.dots.forEach(d => d.visible = false);
    GL.labs.forEach(l => l.visible = false);
    S.trafficN = 0;
  }

  /* altitude hairline */
  const hp = GL.hair.geometry.attributes.position;
  hp.setXYZ(0, P.x, P.y, P.z);
  hp.setXYZ(1, P.x, 0, P.z);
  hp.needsUpdate = true;

  GL.renderer.render(GL.scene, cam);
}

/* ---------------- human language layer ---------------- */
function speedCaption(kmh) {
  if (kmh < 5) return 'standing still';
  if (kmh < 120) return 'faster than a city car';
  if (kmh < 350) return Math.round(kmh / 110) + '× a motorway car';
  return Math.round(kmh / 300) + '× faster than a bullet train';
}

function altCaption(km) {
  if (km < 0.05) return 'on the runway';
  if (km < 1) return 'above the city';
  if (km < 2.5) return 'above the clouds';
  if (km < 4.8) return 'higher than Mont Blanc';
  return 'higher than Everest';
}

function oatCaption(c) {
  if (c > 20) return 'a summer day';
  if (c > 0) return 'a cool day';
  if (c > -20) return 'colder than a freezer';
  if (c > -40) return 'colder than an arctic winter';
  return 'cold enough to freeze your breath';
}

function windCaption(kmh) {
  if (Math.abs(kmh) < 20) return 'calm air';
  return kmh > 0 ? 'tailwind — pushing us along' : 'headwind — slowing us down';
}

function narrator() {
  const near = nearTrafficString();
  const kmh = S.gs * 3.6, km = S.alt / 1000;
  let s;
  if (S.mode === 'demo' || S.mode === 'flying') {
    if (S.alt < 20) {
      if (S.vs > 1) s = 'Wheels up.';
      else if (kmh < 30) s = S.flightT > 60 ? 'Touched down — welcome to Seville.' : 'Lined up on the runway — here we go.';
      else s = 'Rolling down the runway at <b>' + Math.round(kmh) + ' km/h</b>.';
    } else if (Math.abs(S.roll) > 10 && km > 8) {
      s = 'Banking ' + (S.roll > 0 ? 'right' : 'left') + ' — a turn in the flight path.';
    } else if (S.vs > 3) {
      s = 'Climbing through <b>' + km.toFixed(1) + ' km</b> — outside it’s <b>−' + Math.abs(Math.round(S.oatC)) + '°C</b>.';
    } else if (S.vs < -3) {
      s = 'Descending through ' + km.toFixed(1) + ' km — on the ground in about ' +
        (S.mode === 'demo' ? fmtEta(DEMO_T - S.flightT) : fmtEta(liveEta())) + '.';
    } else if (km > 8) {
      s = 'Cruising at <b>' + km.toFixed(1) + ' km</b>, ' + Math.round(kmh) + ' km/h — ' +
        Math.round(S.mach * 100) + '% the speed of sound.';
      if (S.windKt > 15) s += ' Tailwind pushing us along.';
      else if (S.windKt < -15) s += ' Headwind slowing us down.';
      s += ' Seville in ' + (S.mode === 'demo' ? fmtEta(DEMO_T - S.flightT) : fmtEta(liveEta())) + '.';
    } else s = 'Settling into the climb.';
    return near + s;
  }
  if (S.mode === 'armed') return S.fix
    ? 'GPS locked — EZY2899 departs ' + FLIGHT.dep + ', arriving in Seville around 20:00. Waiting for takeoff.'
    : 'Looking for GPS — keep me near a window. EZY2899 leaves at ' + FLIGHT.dep + '.';
  return '';
}

function updateHUD() {
  const kmh = S.gs * 3.6, km = S.alt / 1000;
  H.gs.textContent = group(kmh);
  H.alt.textContent = km.toFixed(1);
  H.oat.textContent = (S.oatC >= 0 ? '+' : '−') + Math.abs(Math.round(S.oatC));
  H.wind.textContent = (S.windKt >= 0 ? '+' : '−') + group(Math.abs(S.windKt * 1.852));
  H.gscap.textContent = speedCaption(kmh);
  H.altcap.textContent = altCaption(km);
  H.oatcap.textContent = oatCaption(S.oatC);
  H.windcap.textContent = windCaption(S.windKt * 1.852);
  H.narr.innerHTML = narrator();
}

function updateStatus() {
  if (S.mode === 'demo') {
    H.status.innerHTML = 'demo <span class="live">· flight ' + fmtT(S.flightT) + '</span>';
    H.pos.textContent = 'brs → svq';
  } else if (S.mode === 'armed') {
    H.status.innerHTML = S.fix ? 'armed · ezy2899 <span class="live">· gps fix</span>' : 'armed · ezy2899 · awaiting gps';
    H.pos.textContent = S.fix ? fmtLat(S.lat) + ' ' + fmtLng(S.lng) : 'no fix — near a window';
  } else if (S.mode === 'flying') {
    H.status.innerHTML = 'live <span class="live">· flight ' + fmtT(S.flightT) + '</span>';
    H.pos.textContent = S.fix ? fmtLat(S.lat) + ' ' + fmtLng(S.lng) : 'no gps — following the planned route';
  } else if (S.mode === 'landed') {
    H.status.textContent = 'landed';
  } else {
    H.status.textContent = '—';
    H.pos.textContent = 'blackbox';
  }
}

let lastDraw = 0, lastHud = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (S.mode === 'demo' && S.t0 != null) {
    const t = (now - S.t0) / 1000;
    if (t < DEMO_T) Object.assign(S, demoStep(t));
  }
  if (now - lastDraw > 40) {
    lastDraw = now;
    draw3D();
  }
  if (now - lastHud > 100) {
    lastHud = now;
    updateHUD(); updateStatus();
  }
}
requestAnimationFrame(frame);

/* ---------------- ui ---------------- */
function hideOverlay() { H.overlay.style.display = 'none'; }

function showOverlay(title, sub, resetOnly) {
  H.overlay.style.display = 'flex';
  document.querySelector('#overlay h1').innerHTML = title;
  H.osub.innerHTML = sub;
  H.start.style.display = resetOnly ? 'none' : '';
  H.demo.style.display = resetOnly ? 'none' : '';
  H.reset.style.display = resetOnly ? '' : 'none';
}

H.demo.onclick = () => {
  S.mode = 'demo'; S.t0 = performance.now(); S.flightT = 0;
  S.samples = []; S.altHist = []; S.maxAlt = 0; S.maxGs = 0;
  hideOverlay();
};

H.start.onclick = async () => {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function')
      await DeviceMotionEvent.requestPermission();
  } catch (e) {}
  S.mode = 'armed'; S.flightT = 0; S.fix = false;
  S.samples = []; S.altHist = []; S.maxAlt = 0; S.maxGs = 0;
  vsEma = 0; lastTickAlt = null; lastTickT = null;
  armGPS();
  hideOverlay();
};

H.reset.onclick = () => location.reload();

/* ---------------- offline ---------------- */
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol))
  navigator.serviceWorker.register('sw.js').catch(() => {});

/* test hook — ?demo=1&t=120 opens the demo at that moment */
(function () {
  const q = new URLSearchParams(location.search);
  if (!q.get('demo')) return;
  S.mode = 'demo';
  S.t0 = performance.now() - parseFloat(q.get('t') || '0') * 1000;
  S.samples = []; S.altHist = []; S.maxAlt = 0; S.maxGs = 0;
  hideOverlay();
})();
