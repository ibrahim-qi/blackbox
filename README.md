# blackbox

A flight data recorder for humans. Runs entirely offline on an iPhone — GPS, gyros,
accelerometer and maths only. The phone never talks to the internet in flight.

- **live mode** — GPS position/speed/altitude, fused attitude (pitch/roll) from gyro +
  accelerometer, derived Mach, outside air temperature and wind, takeoff/landing detection,
  1 Hz black-box log persisted to localStorage.
- **demo mode** — a scripted flight (takeoff roll → rotation → climb → cruise with banks →
  descent → flare) so you can watch the instrument before Tuesday.

## Run the demo

Open `index.html` in any browser → **watch a demo**.

## Flight day checklist (iPhone)

1. Settings → Display & Brightness → **Auto-Lock → Never** (iOS blocks keep-awake APIs)
2. Add to Home Screen from Safari (needs HTTPS hosting)
3. Window seat — GPS needs a view of the sky
4. Phone **flat on the tray table, screen up, top edge toward the nose** — the attitude
   indicator reads the plane's pitch and roll this way
5. Tap **start flight** before pushback, keep the app open and charging

## Sensor sign conventions

Assumes: screen up, top edge = nose. `pitch rate = +rotationRate.beta`,
`roll rate = +rotationRate.gamma`, `pitchA = atan2(ay, az)`, `rollA = atan2(-ax, az)`.
If the horizon is inverted on device, flip the signs in `app.js` (marked with a comment).
The debug line under the HUD shows raw sensor values for tuning.

## Storage

- `blackbox_log` — 1 Hz samples flushed every 10 s
- `blackbox_summary` — written on landing
