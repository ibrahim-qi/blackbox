# blackbox

A flight data recorder for humans. Your phone in the sky — a third-person view of
your own plane, driven by GPS, gyros, accelerometer and maths only. The phone
never talks to the internet in flight.

One view: the 3D model of the plane (a low-poly A320 with amber edges), the earth
with a sliding kilometre grid, the route ahead, passing traffic, and beneath it
four human metrics — speed, altitude, outside, wind — each with a plain-English
caption, plus a one-sentence narrator telling the story of the flight.

- **demo mode** — a scripted flight (runway → rotation → climb → cruise with
  banks → descent → flare) so you can watch the instrument before Tuesday.
- **live mode** — real GPS speed/altitude/position, fused attitude from gyro +
  accelerometer, takeoff/landing detection, 1 Hz black-box log persisted to
  localStorage, dead-reckoning along the planned route when GPS drops out.
  On landing: a summary card; the full report is generated from the log.

## Flight day checklist (iPhone)

1. Settings → Display & Brightness → **Auto-Lock → Never** (iOS blocks keep-awake APIs)
2. Add to Home Screen from Safari
3. Window seat — GPS needs a view of the sky
4. Phone **flat on the tray table, screen up, top edge toward the nose** — the
   model reads the plane's pitch and roll this way
5. Tap **start flight** before pushback, keep the app open and charging

## Sensor sign conventions

Assumes: screen up, top edge = nose. `pitch rate = +rotationRate.beta`,
`roll rate = +rotationRate.gamma`, `pitchA = atan2(ay, az)`, `rollA = atan2(-ax, az)`.
If the model pitches or banks inverted on device, flip the signs in `app.js`
(marked with a comment). The 3D view itself is the diagnostic.

## Storage

- `blackbox_log` — 1 Hz samples flushed every 10 s
- `blackbox_summary` — written on landing

## Test hooks (dev only)

`?demo=1&t=120&shot=1&h=520` — open the demo at a given moment, export a frame of
the WebGL canvas into the DOM (`shotout` img) for headless verification.
`?live=1` — compressed synthetic-GPS flight through the real route, exercising
armed → takeoff → recording → gps dropout → dead reckoning → landing.
`?landtest=1` — render the landing summary overlay.
`cam/ch/lt/clean/nofog/discr/groundred` — scene debugging knobs.
