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
  narr: $('narr'), note: $('note'),
  gl: $('gl'),
  overlay: $('overlay'), osub: $('osub'), check: $('check'), start: $('start'), demo: $('demo'),
  reset: $('reset'), vreport: $('vreport'), deptime: $('deptime'),
  report: $('report'), rflight: $('rflight'), rstats: $('rstats'), rstats2: $('rstats2'),
  rtrack: $('rtrack'), rprofile: $('rprofile'), rclose: $('rclose')
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
const fmtEta = s => { s = Math.max(0, s | 0); if (s < 60) return s + 's'; const h = (s / 3600) | 0, m = Math.round((s % 3600) / 60); return h ? h + 'h ' + m + 'm' : m + 'm'; };

/* ---------------- atmosphere model (ISA) ---------------- */
function isa(altM) {
  const T = altM < 11000 ? 288.15 - 0.0065 * altM : 216.65;   // kelvin
  return { T, a: 340.294 * Math.sqrt(T / 288.15) };           // a = speed of sound, m/s
}

/* ---------------- demo flight (1 demo s = 1 real flight min) ---------------- */
const DEMO_T = 301;
const BRS = { lat: 51.3827, lng: -2.7191 }, SVQ = { lat: 37.418, lng: -5.8988 };
/* the real flight — update dep/durMin from the boarding pass if they differ */
const FLIGHT = { cs: 'EZY2899', from: 'BRS', to: 'SVQ', aircraft: 'A320', dep: '16:40', durMin: 148 };
const DEP_TIMES = ['15:35', '16:40', '17:35'];   // tap the start screen to adjust

/* restore a tapped departure time */
try {
  const d = localStorage.getItem('bb_dep');
  if (DEP_TIMES.includes(d)) FLIGHT.dep = d;
} catch (e) {}

function liveEta() {
  const dep = new Date('2026-08-18T' + FLIGHT.dep + ':00+01:00').getTime();   // BST
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
  if (S.mode === 'flying' || S.mode === 'armed') {
    S.pitch = pitchSign * FUSE.pitch;
    S.roll = rollSign * FUSE.roll;
  }
});

/* ---------------- self-calibrating attitude ----------------
   If a device reports inverted sensors, sustained physical evidence
   flips the signs automatically and remembers the choice. */
let pitchSign = 1, rollSign = 1;
try {
  pitchSign = parseInt(localStorage.getItem('bb_sign_p') || '1') || 1;
  rollSign = parseInt(localStorage.getItem('bb_sign_r') || '1') || 1;
} catch (e) {}

let pitchEv = 0, rollEv = 0, lastHdg = null, lastHdgT = 0;

function attitudeCalibrate() {
  if (S.mode !== 'flying') return;
  /* pitch: a sustained climb must read as positive pitch */
  if (S.vs > 3 && Math.abs(FUSE.pitch) > 5) pitchEv++; else pitchEv = 0;
  if (pitchEv > 15 && FUSE.pitch * pitchSign < 0) {
    pitchSign = -pitchSign;
    try { localStorage.setItem('bb_sign_p', String(pitchSign)); } catch (e) {}
    pitchEv = 0;
  }
  /* roll: the bank direction must match the turn direction */
  const now = performance.now();
  if (lastHdg != null && S.heading != null) {
    let d = S.heading - lastHdg;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const dt = (now - lastHdgT) / 1000;
    if (dt > 0 && dt < 5 && Math.abs(d) / dt > 0.008 && Math.abs(FUSE.roll) > 5) {
      if (Math.sign(d) !== Math.sign(FUSE.roll * rollSign)) rollEv++;
      else rollEv = Math.max(0, rollEv - 1);
      if (rollEv > 8) {
        rollSign = -rollSign;
        try { localStorage.setItem('bb_sign_r', String(rollSign)); } catch (e) {}
        rollEv = 0;
      }
    }
  }
  lastHdg = S.heading; lastHdgT = now;
}

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

function tick() {
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
      attitudeCalibrate();
      if (S.flightT > 60 && S.gs * MS2KT < 25 && S.alt < 150) land();
    }
  }
}
setInterval(tick, 1000);

/* ---------------- flight report ---------------- */
function drawReportTrack(samples) {
  const cv = H.rtrack, dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h || samples.length < 2) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#070706'; ctx.fillRect(0, 0, w, h);
  let mnLat = 90, mxLat = -90, mnLng = 180, mxLng = -180;
  for (const s of samples) {
    if (s.lat == null) continue;
    mnLat = Math.min(mnLat, s.lat); mxLat = Math.max(mxLat, s.lat);
    mnLng = Math.min(mnLng, s.lng); mxLng = Math.max(mxLng, s.lng);
  }
  const pad = 24;
  const sc = Math.min((w - pad * 2) / Math.max(mxLng - mnLng, .001), (h - pad * 2) / Math.max(mxLat - mnLat, .001));
  const X = lng => (lng - mnLng) * sc + pad + (w - pad * 2 - (mxLng - mnLng) * sc) / 2;
  const Y = lat => h - pad - (lat - mnLat) * sc;
  ctx.strokeStyle = 'rgba(255,180,84,.9)'; ctx.lineWidth = 1.2;
  ctx.beginPath();
  let st = false;
  for (const s of samples) {
    if (s.lat == null) { st = false; continue; }
    const x = X(s.lng), y = Y(s.lat);
    if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  const a = samples[0], b = samples[samples.length - 1];
  ctx.fillStyle = '#e6e1d6'; ctx.font = '10px ui-monospace,Menlo,monospace';
  ctx.fillStyle = '#5c574e';
  ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText(FLIGHT.from, X(a.lng) + 5, Y(a.lat) - 3);
  ctx.textAlign = 'right';
  ctx.fillText(FLIGHT.to, X(b.lng) - 5, Y(b.lat) - 3);
  ctx.fillStyle = '#e6e1d6';
  ctx.beginPath(); ctx.arc(X(a.lng), Y(a.lat), 2, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(X(b.lng), Y(b.lat), 2, 0, 7); ctx.fill();
}

function drawReportProfile(samples) {
  const cv = H.rprofile, dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h || samples.length < 2) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  let mn = 1e9, mx = -1e9;
  for (const s of samples) { mn = Math.min(mn, s.alt); mx = Math.max(mx, s.alt); }
  const span = (mx - mn) || 1;
  ctx.strokeStyle = 'rgba(255,180,84,.85)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const x = (i / (samples.length - 1)) * (w - 8) + 4;
    const y = h - 8 - ((samples[i].alt - mn) / span) * (h - 16);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = '#5c574e'; ctx.font = '8px ui-monospace,Menlo,monospace';
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText('your climb & descent', w - 4, 4);
}

function renderReport() {
  let samples = S.samples;
  if (!samples.length) {
    try { samples = JSON.parse(localStorage.getItem('blackbox_log') || '{"samples":[]}').samples; } catch (e) { samples = []; }
  }
  if (samples.length < 2) return;
  const dur = samples[samples.length - 1].t;
  let maxAlt = 0, maxGs = 0, maxWind = -1e9, maxAltT = 0, touchdown = null;
  for (const s of samples) {
    if (s.alt > maxAlt) { maxAlt = s.alt; maxAltT = s.t; }
    if (s.gs > maxGs) maxGs = s.gs;
    if (s.wind > maxWind) maxWind = s.wind;
  }
  for (const s of samples) {
    if (s.t > maxAltT && s.alt < 50) { touchdown = s.t; break; }
  }
  const passed = [];
  for (const c of DEMO_CITIES) {
    if (samples.some(s => s.lat != null &&
        Math.abs(s.lat - c[1]) * 110.54 < 40 &&
        Math.abs(s.lng - c[2]) * 111.32 * Math.cos(c[1] * Math.PI / 180) < 40))
      passed.push(c[0]);
  }
  H.report.classList.add('show');
  H.rflight.textContent = FLIGHT.cs + ' · ' + FLIGHT.from + ' → ' + FLIGHT.to + ' · ' + samples.length + ' samples';
  H.rstats.innerHTML = 'in the air <b>' + fmtT(dur) + '</b> · highest <b>' + (maxAlt / 1000).toFixed(1) + ' km</b> · fastest <b>' +
    group(maxGs * 3.6) + ' km/h</b>' +
    (maxWind > 0 ? ' · best tailwind <b>+' + group(maxWind * 1.852) + ' km/h</b>' : '') +
    (touchdown != null ? ' · touchdown at <b>T+' + fmtT(touchdown) + '</b>' : '');
  H.rstats2.textContent = passed.length ? 'you flew over ' + passed.join(' · ') : '';
  drawReportTrack(samples);
  drawReportProfile(samples);
}

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
  let el = Math.asin(sinEl);
  if (el < 0.1) el = 0.35;   // night demos still read well — never fully dark
  const cosAz = (Math.sin(decl) - Math.sin(lat) * sinEl) / (Math.cos(lat) * Math.cos(el));
  const az = Math.acos(clamp(cosAz, -1, 1));
  const azimuth = Math.sin(ha) > 0 ? az : -az;              // east positive
  return new THREE.Vector3(Math.cos(el) * Math.sin(azimuth), Math.sin(el), -Math.cos(el) * Math.cos(azimuth));
}

/* the plane — a low-poly a320 built from geometry, nose +Z, wings ±X, up +Y */
function buildPlane() {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x4a4b51, flatShading: true, side: THREE.DoubleSide });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xffb454, transparent: true, opacity: .7 });

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
let tilePending = 0;

function doShot() {
  try {
    const url = H.gl.toDataURL('image/png');
    const img = document.createElement('img');
    img.id = 'shotout';
    img.src = url;
    img.style.cssText = S.shotVis
      ? 'position:fixed;left:0;top:0;z-index:99;width:' + H.gl.clientWidth + 'px;'
      : 'display:none;';
    document.body.appendChild(img);
    console.log('SHOT ready len', url.length);
  } catch (e) { console.log('SHOT err', e.message); }
}

/* real earth — cached carto dark tiles along the corridor */
function tileBounds(z, x, y) {
  const n = 2 ** z;
  const w = x / n * 360 - 180, e = (x + 1) / n * 360 - 180;
  const s = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  const n2 = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  return { s, n: n2, w, e };
}

function addTile(t) {
  const b = tileBounds(t.z, t.x, t.y);
  const a = toXY(b.n, b.w), c = toXY(b.s, b.e);
  const w = Math.abs(c[0] - a[0]), h = Math.abs(c[1] - a[1]);
  const img = new Image();
  tilePending++;
  img.onload = () => {
    tilePending--;
    if (!GL) return;
    const tex = new THREE.Texture(img);
    tex.encoding = THREE.sRGBEncoding;      // r147 api
    tex.needsUpdate = true;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex })
    );
    m.geometry.rotateX(-Math.PI / 2);
    m.position.set((a[0] + c[0]) / 2, 0.5, -(a[1] + c[1]) / 2);
    GL.scene.add(m);
    if (tilePending === 0 && S.shotWait) { GL.cam = null; draw3D(); doShot(); }
  };
  img.onerror = () => {
    tilePending--;
    if (tilePending === 0 && S.shotWait) { GL.cam = null; draw3D(); doShot(); }
  };
  img.src = 'tiles/' + t.z + '/' + t.x + '/' + t.y + '.png';
}

function glInit() {
  const cv = H.gl;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h || typeof THREE === 'undefined') return false;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, preserveDrawingBuffer: true });
  } catch (e) { return false; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050505);
  if (!S.noFog) scene.fog = new THREE.Fog(0x050505, 60000, 280000);
  const camera = new THREE.PerspectiveCamera(55, w / h, 10, 3000000);
  scene.add(new THREE.AmbientLight(0xffffff, .75));
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(-30000, 40000, -20000);
  scene.add(sun);

  const plane = buildPlane();
  plane.rotation.order = 'YXZ';
  scene.add(plane);

  /* the earth — a dark disc with a horizon, grid etched on top */
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(S.discR || 400000, 48),
    new THREE.MeshBasicMaterial({ color: S.groundRed ? 0xff0000 : 0x262019 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.frustumCulled = false;
  scene.add(ground);

  if (!S.clean) {
    /* planned route, always visible — the map's own labels name the cities */
    const routePts = [];
    for (let i = 0; i <= 80; i++) {
      const f = i / 80;
      const lat = BRS.lat + (SVQ.lat - BRS.lat) * f;
      const lng = BRS.lng + (SVQ.lng - BRS.lng) * f - 0.8 * Math.sin(Math.PI * f);
      const xy = toXY(lat, lng);
      routePts.push(new THREE.Vector3(xy[0], 0, -xy[1]));
    }
    const routeLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(routePts),
      new THREE.LineBasicMaterial({ color: 0xffb454, transparent: true, opacity: .45 })
    );
    routeLine.position.y = 4;
    scene.add(routeLine);
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
    new THREE.LineBasicMaterial({ color: 0xe6e1d6, transparent: true, opacity: .22 })
  );
  scene.add(hair);

  GL = { renderer, scene, camera, plane, ground, dots, labs, hair, cam: null, sun };
  (window.BLACKBOX_TILES || []).slice(S.tileOff || 0, S.tileMax < 0 ? 1e9 : (S.tileOff || 0) + S.tileMax).forEach(t => addTile(t));
  return true;
}

function draw3D() {
  if (S.mode === 'idle') return;   // nothing to show behind the start screen
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
  pl.position.set(P.x, P.y + 2.5, P.z);   // fuselage rides above the runway, not in it
  pl.rotation.y = Math.PI - psi;
  pl.rotation.x = -S.pitch * Math.PI / 180;
  pl.rotation.z = -S.roll * Math.PI / 180;

  /* earth + grid follow the plane */
  GL.ground.position.set(P.x, 0, P.z);

  /* cinematic chase cam — behind and above, softly damped */
  const D = S.camD || 100, CH = S.camH || 42, LT = S.camL || 0;
  const eye = new THREE.Vector3(P.x - fw[0] * D, P.y + CH, P.z - fw[1] * D);
  if (!GL.cam || GL.cam.distanceTo(eye) > 2000) GL.cam = eye.clone();   // snap on big jumps
  else GL.cam.lerp(eye, .14);
  cam.position.copy(GL.cam);
  cam.lookAt(P.x + fw[0] * LT, P.y, P.z + fw[1] * LT);

  /* shade the plane with the real sun */
  GL.sun.position.copy(sunDir().multiplyScalar(40000));

  /* typical traffic */
  if (S.mode === 'demo' && !S.clean) {
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
  hp.setXYZ(0, P.x, P.y + 2.5, P.z);
  hp.setXYZ(1, P.x, 4, P.z);
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
      else if (kmh < 220 && S.flightT > 60) s = 'Slowing on the runway — welcome to Seville.';
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
        Math.round(S.mach * 100) + '% the speed of sound. Seville in ' +
        (S.mode === 'demo' ? fmtEta(DEMO_T - S.flightT) : fmtEta(liveEta())) + '.';
    } else s = 'Settling into the climb.';
    if (near) return near.slice(0, -1);   // a passing plane owns the line for a moment
    return s;
  }
  if (S.mode === 'armed') return S.fix
    ? 'GPS locked — EZY2899 departs ' + FLIGHT.dep + ', arriving in Seville around 20:00. Waiting for takeoff.'
    : 'Looking for GPS — keep me near a window. EZY2899 leaves at ' + FLIGHT.dep + '.';
  return '';
}

function updateHUD() {
  const kmh = S.gs * 3.6, km = S.alt / 1000;
  S.oatC = isa(S.alt).T - 273.15;      // pure function of altitude — can never go stale
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
  /* the flight-day checklist only matters before takeoff */
  if (H.note) H.note.style.display = S.mode === 'armed' ? '' : 'none';
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
function hideOverlay() { H.overlay.classList.add('hidden'); }

function showOverlay(title, sub, resetOnly) {
  H.overlay.classList.remove('hidden');
  document.querySelector('#overlay h1').innerHTML = title;
  H.osub.innerHTML = sub;
  H.check.style.display = resetOnly ? 'none' : '';
  H.start.style.display = resetOnly ? 'none' : '';
  H.demo.style.display = resetOnly ? 'none' : '';
  H.reset.style.display = resetOnly ? '' : 'none';
  H.vreport.style.display = resetOnly ? '' : 'none';
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

H.vreport.onclick = () => { H.overlay.style.display = 'none'; renderReport(); };
H.rclose.onclick = () => location.reload();

H.deptime.onclick = () => {
  const i = DEP_TIMES.indexOf(FLIGHT.dep);
  FLIGHT.dep = DEP_TIMES[(i + 1) % DEP_TIMES.length];
  try { localStorage.setItem('bb_dep', FLIGHT.dep); } catch (e) {}
  H.deptime.textContent = FLIGHT.dep;
};
H.deptime.textContent = FLIGHT.dep;

/* ---------------- offline ---------------- */
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol))
  navigator.serviceWorker.register('sw.js').catch(() => {});

/* test hook — ?demo=1&t=120 opens the demo at that moment */
(function () {
  const q = new URLSearchParams(location.search);
  if (!q.get('demo') && !q.get('live') && !q.get('landtest') && !q.get('report') && !q.get('signtest') && !q.get('tilecheck')) return;
  S.camD = parseFloat(q.get('cam') || '0') || null;
  S.camH = parseFloat(q.get('ch') || '0') || null;
  S.camL = parseFloat(q.get('lt') || '0') || null;
  S.clean = !!q.get('clean');
  S.noFog = !!q.get('nofog');
  S.groundRed = !!q.get('groundred');
  S.discR = parseFloat(q.get('discr') || '0') || null;
  S.tileMax = q.get('tilemax') == null ? -1 : parseInt(q.get('tilemax'));
  S.tileOff = parseInt(q.get('tileoff') || '0') || 0;
  S.shotVis = !!q.get('shotvis');
  const hq = parseFloat(q.get('h') || '0');
  if (hq) { H.gl.style.height = hq + 'px'; H.gl.style.flex = 'none'; }
  if (q.get('test')) document.body.style.background = 'rgb(200,0,0)';
  if (q.get('demo')) {
    S.mode = 'demo';
    const t = parseFloat(q.get('t') || '0');
    S.t0 = performance.now() - t * 1000;
    S.samples = []; S.altHist = []; S.maxAlt = 0; S.maxGs = 0;
    hideOverlay();
    /* paint state synchronously so headless dumps are deterministic */
    Object.assign(S, demoStep(t));
    S.flightT = t;
    updateHUD(); updateStatus();
  }
  if (q.get('shot')) {
    glInit(); draw3D();
    if (q.get('shotwait')) {
      S.shotWait = true;   // tiles load async — shoot when they land
      if (!(S.tileMax > 0)) setTimeout(() => { GL.cam = null; draw3D(); doShot(); }, 3000);
    } else doShot();
  }
  if (q.get('landtest')) {
    /* simulate a finished flight and verify the complete overlay */
    S.mode = 'flying';
    S.flightT = 8400;
    S.maxAlt = 10668;
    S.maxGs = 470;
    S.samples = Array(100).fill(1);
    land();
  }
  if (q.get('tilecheck')) {
    /* draw a downloaded earth tile into a 2d canvas — visible in plain screenshots */
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.id = 'tileout'; cv.width = 256; cv.height = 256;
      cv.style.cssText = 'position:fixed;left:0;top:0;z-index:99;';
      cv.getContext('2d').drawImage(img, 0, 0);
      document.body.appendChild(cv);
    };
    img.onerror = () => { console.log('TILECHECK err'); };
    img.src = 'tiles/8/126/92.png';
  }
  if (q.get('report')) {
    /* a full synthetic flight → render the report for verification */
    S.samples = [];
    for (let i = 0; i <= 300; i++) {
      const o = demoStep(i);
      S.samples.push({ t: i, lat: o.lat, lng: o.lng, alt: o.alt, gs: o.gs, vs: o.vs, wind: o.windKt, pitch: o.pitch, roll: o.roll });
    }
    S.maxAlt = 10668; S.maxGs = 265;
    hideOverlay();
    renderReport();
  }
  if (q.get('signtest')) {
    /* inverted sensors → the calibrator must flip both signs */
    S.mode = 'flying'; S.vs = 10; FUSE.pitch = -8;
    const realNow = performance.now;
    let vt = 0;
    performance.now = () => ++vt * 1000;      // one virtual second per call
    try {
      for (let i = 0; i < 20; i++) attitudeCalibrate();
      const pAfter = pitchSign;
      FUSE.roll = -10; FUSE.pitch = 0; lastHdg = null; S.heading = 0;
      for (let i = 0; i < 20; i++) { S.heading += 0.02; attitudeCalibrate(); }
      console.log('SIGNS pitch', pAfter, '->', pitchSign, '| roll ->', rollSign);
    } finally { performance.now = realNow; }
  }
  if (q.get('live')) {
    /* synthetic gps along the real route, compressed — exercises the whole
       live path: armed → takeoff detection → recording → gps dropout →
       dead reckoning → landing detection → complete */
    S.mode = 'armed';
    S.fix = true;
    S.liveT = 0;
    const realNow = performance.now;
    performance.now = () => S.liveT * 1000;     // tick sees a 1s clock
    try {
      for (let i = 0; i < 340; i++) {
        S.liveT += 1;
        S.fix = S.liveT < 30 || S.liveT > 45;   // gps drops mid-climb
        if (S.fix) {
          const o = demoStep(S.liveT);
          S.lat = o.lat; S.lng = o.lng; S.alt = o.alt; S.gs = o.gs;
        }
        tick();
      }
    } finally { performance.now = realNow; }
    updateHUD(); updateStatus();
  }
})();
