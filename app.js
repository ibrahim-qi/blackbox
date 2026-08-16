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
  narr: $('narr'), pro: $('pro'),
  view: $('view'),
  dbg: $('dbg'), horizon: $('horizon'), profile: $('profile'),
  overlay: $('overlay'), osub: $('osub'), start: $('start'), demo: $('demo'), reset: $('reset')
};

/* ---------------- state ---------------- */
const S = {
  mode: 'idle',            // idle | demo | armed | flying | landed
  t0: null,                // demo start (performance.now)
  flightT: 0,              // flight time, s
  gs: 0, alt: 0, vs: 0,    // m/s, m, m/s
  pitch: 0, roll: 0,       // deg
  attWord: '',             // what the plane is doing, in words
  heading: 0,              // rad, true north clockwise
  view: 'dial',            // dial | 3d
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
const LON = { lat: 51.47, lng: -0.45 }, SVQ = { lat: 37.42, lng: -5.90 };

function demoStep(t) {
  const o = { gs: 0, alt: 0, vs: 0, pitch: 0, roll: 0, mach: .78, windKt: 0, lat: LON.lat, lng: LON.lng, eta: DEMO_T - t };
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
  o.lat = LON.lat + (SVQ.lat - LON.lat) * f;
  o.lng = LON.lng + (SVQ.lng - LON.lng) * f - 0.8 * Math.sin(Math.PI * f);
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
    if (!S.fix) return;
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
const ACCENT = '#ffb454';

function sizeCv(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (w && (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr))) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  return dpr;
}

function drawADI(pitch, roll) {
  const cv = H.horizon, dpr = sizeCv(cv);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#070706'; ctx.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, ppd = h / 50;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-roll * Math.PI / 180);
  const hy = pitch * ppd;
  ctx.fillStyle = '#0c0b09'; ctx.fillRect(-cx, hy, w, h);
  ctx.strokeStyle = 'rgba(230,225,214,.28)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(-cx, hy); ctx.lineTo(cx, hy); ctx.stroke();
  ctx.font = '9px ui-monospace,Menlo,monospace';
  for (let d = -30; d <= 30; d += 5) {
    const y = hy - d * ppd;
    if (y < -h / 2 || y > h / 2) continue;
    const len = d % 10 === 0 ? 26 : 13;
    ctx.strokeStyle = d % 10 === 0 ? 'rgba(230,225,214,.45)' : 'rgba(230,225,214,.18)';
    ctx.beginPath(); ctx.moveTo(-len, y); ctx.lineTo(len, y); ctx.stroke();
    if (d % 10 === 0) {
      ctx.fillStyle = '#5c574e'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(String(Math.abs(d)), len + 5, y);
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.abs(d)), -len - 5, y);
    }
  }
  ctx.restore();

  /* roll index */
  ctx.strokeStyle = 'rgba(230,225,214,.2)';
  ctx.beginPath(); ctx.arc(cx, cy, h / 2 - 22, -Math.PI, 0); ctx.stroke();
  const rx = cx + Math.sin(-roll * Math.PI / 180) * (h / 2 - 22);
  const ry = cy - Math.cos(-roll * Math.PI / 180) * (h / 2 - 22);
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.moveTo(rx, ry - 4); ctx.lineTo(rx - 5, ry - 11); ctx.lineTo(rx + 5, ry - 11);
  ctx.closePath(); ctx.fill();

  /* aircraft symbol */
  ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 34, cy); ctx.lineTo(cx - 9, cy);
  ctx.moveTo(cx + 9, cy); ctx.lineTo(cx + 34, cy);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 2.2, 0, 7); ctx.fillStyle = ACCENT; ctx.fill();

  /* what the plane is doing, in words, inside the dial */
  if (S.attWord) {
    ctx.fillStyle = 'rgba(255,180,84,.75)';
    ctx.font = '9px ui-monospace,Menlo,monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(S.attWord.toUpperCase().split('').join(' '), cx, cy + 30);
  }
}

/* ---------------- 3d chase view (fully offline) ---------------- */
const DEMO_CITIES = [
  ['nantes', 47.2184, -1.5536],
  ['bordeaux', 44.8378, -0.5792],
  ['san sebastian', 43.3183, -1.9812],
  ['seville', 37.3891, -5.9845]
];

const norm3 = v => { const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / m, v[1] / m, v[2] / m]; };
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function bearing(a, b) {
  const f1 = a.lat * Math.PI / 180, f2 = b.lat * Math.PI / 180;
  const dl = (b.lng - a.lng) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return Math.atan2(y, x);
}

function draw3D() {
  const cv = H.horizon, dpr = sizeCv(cv);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, w, h);

  const lat0 = S.mode === 'demo' ? LON.lat : S.lat, lng0 = S.mode === 'demo' ? LON.lng : S.lng;
  const toXY = (lat, lng) => [(lng - lng0) * Math.cos(lat0 * Math.PI / 180) * 111320, (lat - lat0) * 110540];

  let psi;
  if (S.mode === 'demo') psi = bearing(demoStep(Math.max(0, S.flightT - 0.5)), demoStep(S.flightT + 0.5));
  else psi = S.heading || 0;

  const p0 = toXY(S.lat, S.lng);
  const P = [p0[0], p0[1], S.alt];
  const fw = [Math.sin(psi), Math.cos(psi), 0];
  const D = 200, CH = 55, LT = 70;
  const E = [P[0] - fw[0] * D, P[1] - fw[1] * D, P[2] + CH];
  const T = [P[0] + fw[0] * LT, P[1] + fw[1] * LT, P[2]];
  const zax = norm3([E[0] - T[0], E[1] - T[1], E[2] - T[2]]);
  const xax = norm3(cross3([0, 0, 1], zax));
  const yax = cross3(zax, xax);
  const focal = w * 1.15, cx = w / 2, cy = h / 2;

  const toScr = q => {
    const dx = (q[0] - E[0]) * xax[0] + (q[1] - E[1]) * xax[1] + (q[2] - E[2]) * xax[2];
    const dy = (q[0] - E[0]) * yax[0] + (q[1] - E[1]) * yax[1] + (q[2] - E[2]) * yax[2];
    const dz = (q[0] - E[0]) * zax[0] + (q[1] - E[1]) * zax[1] + (q[2] - E[2]) * zax[2];
    return dz > 0.5 ? [cx + dx * focal / dz, cy - dy * focal / dz] : null;
  };

  /* ground grid */
  ctx.strokeStyle = 'rgba(230,225,214,.05)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let g = -12000; g <= 12000; g += 1000) {
    let a = toScr([P[0] + g, P[1] - 12000, 0]), b = toScr([P[0] + g, P[1] + 12000, 0]);
    if (a && b) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    a = toScr([P[0] - 12000, P[1] + g, 0]); b = toScr([P[0] + 12000, P[1] + g, 0]);
    if (a && b) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
  }
  ctx.stroke();

  /* route + cities (demo) */
  if (S.mode === 'demo') {
    ctx.strokeStyle = 'rgba(255,180,84,.28)';
    ctx.beginPath(); let started = false;
    for (let i = 0; i <= 80; i++) {
      const f = i / 80;
      const lat = LON.lat + (SVQ.lat - LON.lat) * f;
      const lng = LON.lng + (SVQ.lng - LON.lng) * f - 0.8 * Math.sin(Math.PI * f);
      const s = toScr([...toXY(lat, lng), 0]);
      if (!s) { started = false; continue; }
      if (!started) { ctx.moveTo(s[0], s[1]); started = true; } else ctx.lineTo(s[0], s[1]);
    }
    ctx.stroke();
    ctx.font = '9px ui-monospace,Menlo,monospace';
    for (const [name, lat, lng] of DEMO_CITIES) {
      const s = toScr([...toXY(lat, lng), 0]);
      if (!s) continue;
      ctx.strokeStyle = 'rgba(230,225,214,.35)';
      ctx.beginPath();
      ctx.moveTo(s[0] - 3, s[1]); ctx.lineTo(s[0] + 3, s[1]);
      ctx.moveTo(s[0], s[1] - 3); ctx.lineTo(s[0], s[1] + 3);
      ctx.stroke();
      ctx.fillStyle = 'rgba(230,225,214,.4)'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(name.toUpperCase(), s[0] + 5, s[1] - 3);
    }
  }

  /* altitude hairline down to the ground */
  const ga = toScr(P), gb = toScr([P[0], P[1], 0]);
  if (ga && gb) {
    ctx.strokeStyle = 'rgba(230,225,214,.15)';
    ctx.beginPath(); ctx.moveTo(ga[0], ga[1]); ctx.lineTo(gb[0], gb[1]); ctx.stroke();
  }

  /* the plane — wireframe, real attitude */
  const model = [
    [[0, 4.5, 0], [0, -3.5, 0]],
    [[6, 0.2, 0], [1.2, 0.3, 0]],
    [[-6, 0.2, 0], [-1.2, 0.3, 0]],
    [[2.2, -3.2, 0], [-2.2, -3.2, 0]],
    [[0, -2.8, 0], [0, -2.8, 1.6]]
  ];
  const pr = S.pitch * Math.PI / 180, rr = S.roll * Math.PI / 180;
  const cp = Math.cos(pr), sp = Math.sin(pr), cr = Math.cos(rr), sr = Math.sin(rr);
  const rx = q => [q[0], q[1] * cp - q[2] * sp, q[1] * sp + q[2] * cp];
  const ry = q => [q[0] * cr + q[2] * sr, q[1], -q[0] * sr + q[2] * cr];
  const yaw = q => [q[0] * Math.cos(psi) + q[1] * Math.sin(psi), -q[0] * Math.sin(psi) + q[1] * Math.cos(psi), q[2]];
  ctx.strokeStyle = 'rgba(255,180,84,.9)'; ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (const [a, b] of model) {
    const A = yaw(ry(rx(a))), B = yaw(ry(rx(b)));
    const sa = toScr([P[0] + A[0], P[1] + A[1], P[2] + A[2]]);
    const sb = toScr([P[0] + B[0], P[1] + B[1], P[2] + B[2]]);
    if (sa && sb) { ctx.moveTo(sa[0], sa[1]); ctx.lineTo(sb[0], sb[1]); }
  }
  ctx.stroke();
}

function drawProfile() {
  const cv = H.profile, dpr = sizeCv(cv);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const xs = S.altHist;
  if (xs.length < 2) return;
  const min = Math.min.apply(null, xs), max = Math.max.apply(null, xs);
  const span = (max - min) || 1;
  ctx.strokeStyle = 'rgba(255,180,84,.85)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < xs.length; i++) {
    const x = (i / (xs.length - 1)) * (w - 8) + 4;
    const y = h - 10 - ((xs[i] - min) / span) * (h - 22);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  const last = xs[xs.length - 1];
  const lx = w - 4, ly = h - 10 - ((last - min) / span) * (h - 22);
  ctx.fillStyle = ACCENT; ctx.beginPath(); ctx.arc(lx, ly, 2, 0, 7); ctx.fill();
  ctx.fillStyle = '#5c574e'; ctx.font = '8px ui-monospace,Menlo,monospace';
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText('your climb & descent', w - 4, 4);
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
  const kmh = S.gs * 3.6, km = S.alt / 1000;
  if (S.mode === 'demo' || S.mode === 'flying') {
    if (S.alt < 20) {
      if (S.vs > 1) return 'Wheels up.';
      if (kmh < 30) return S.flightT > 60 ? 'Touched down — welcome to Seville.' : 'Lined up on the runway — here we go.';
      return 'Rolling down the runway at <b>' + Math.round(kmh) + ' km/h</b>.';
    }
    if (Math.abs(S.roll) > 10 && km > 8)
      return 'Banking ' + (S.roll > 0 ? 'right' : 'left') + ' — a turn in the flight path.';
    if (S.vs > 3)
      return 'Climbing through <b>' + km.toFixed(1) + ' km</b> — outside it’s <b>−' + Math.abs(Math.round(S.oatC)) + '°C</b>.';
    if (S.vs < -3)
      return 'Descending through ' + km.toFixed(1) + ' km — on the ground in about ' +
        (S.mode === 'demo' ? fmtEta(DEMO_T - S.flightT) : '15 minutes') + '.';
    if (km > 8) {
      let s = 'Cruising at <b>' + km.toFixed(1) + ' km</b>, ' + Math.round(kmh) + ' km/h — ' +
        Math.round(S.mach * 100) + '% the speed of sound.';
      if (S.windKt > 15) s += ' Tailwind pushing us along.';
      else if (S.windKt < -15) s += ' Headwind slowing us down.';
      if (S.mode === 'demo') s += ' Seville in ' + fmtEta(DEMO_T - S.flightT) + '.';
      return s;
    }
    return 'Settling into the climb.';
  }
  if (S.mode === 'armed') return S.fix ? 'GPS locked — waiting for takeoff.' : 'Looking for GPS — keep me near a window.';
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
  if (S.mode !== 'demo' && S.mode !== 'flying') S.attWord = '';
  else if (Math.abs(S.roll) > 10) S.attWord = S.roll > 0 ? 'banking right' : 'banking left';
  else if (S.vs > 3) S.attWord = 'climbing';
  else if (S.vs < -3) S.attWord = 'descending';
  else if (S.alt < 20) S.attWord = S.gs * MS2KT > 25 ? 'rolling' : 'on the ground';
  else S.attWord = 'level flight';
  H.pro.textContent = (S.mode === 'demo' ? 'simulated · ' : '') + 'pilot units · ' +
    group(S.gs * MS2KT) + ' kt · M ' + S.mach.toFixed(2) + ' · FL' +
    Math.round(S.alt * M2FT / 100) + ' · ' + (S.vs >= 0 ? '+' : '−') + group(Math.abs(S.vs * MS2FPM)) + ' fpm';
}

function updateStatus() {
  if (S.mode === 'demo') {
    H.status.innerHTML = 'demo <span class="live">· t+' + fmtT(S.flightT) + '</span>';
    H.pos.textContent = 'lon → svq';
  } else if (S.mode === 'armed') {
    H.status.innerHTML = S.fix ? 'armed <span class="live">· gps fix</span>' : 'armed · awaiting gps';
    H.pos.textContent = S.fix ? fmtLat(S.lat) + ' ' + fmtLng(S.lng) : 'no fix — near a window';
  } else if (S.mode === 'flying') {
    H.status.innerHTML = 'live <span class="live">· t+' + fmtT(S.flightT) + '</span>';
    H.pos.textContent = S.fix ? fmtLat(S.lat) + ' ' + fmtLng(S.lng) : 'dead reckoning';
  } else if (S.mode === 'landed') {
    H.status.textContent = 'landed';
  } else {
    H.status.textContent = '—';
    H.pos.textContent = 'blackbox';
  }
}

function updateDbg() {
  if (S.mode === 'armed' || S.mode === 'flying') {
    H.dbg.textContent = 'ax ' + DBG.ax.toFixed(2) + ' ay ' + DBG.ay.toFixed(2) + ' az ' + DBG.az.toFixed(2) +
      ' · β ' + DBG.ry.toFixed(1) + ' γ ' + DBG.rz.toFixed(1) +
      ' · p ' + FUSE.pitch.toFixed(1) + '° r ' + FUSE.roll.toFixed(1) + '°' +
      (S.fixAcc != null ? ' · fix ±' + Math.round(S.fixAcc) + 'm' : '');
  } else {
    H.dbg.textContent = S.mode === 'demo' ? 'sensor debug appears in live mode' : '';
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
    if (S.view === '3d') draw3D(); else drawADI(S.pitch, S.roll);
    drawProfile();
  }
  if (now - lastHud > 100) {
    lastHud = now;
    updateHUD(); updateStatus(); updateDbg();
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

H.view.onclick = () => {
  S.view = S.view === 'dial' ? '3d' : 'dial';
  H.view.textContent = S.view;
};

/* ---------------- offline ---------------- */
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol))
  navigator.serviceWorker.register('sw.js').catch(() => {});
