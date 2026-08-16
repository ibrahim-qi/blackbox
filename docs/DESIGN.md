# blackbox — design system

## The vibe

**An instrument, not an app.** Near-black OLED, hairline strokes, monospace type,
one amber accent, nothing decorative — no shadows, no gradients, no chrome.
Every pixel informs or disappears. The content speaks human.

## Principles

1. **The plane is the UI.** One view. The 3D model is the centre of everything;
   no modes, no toggles, no screens to switch.
2. **Human language only.** Every metric carries a plain-English caption;
   one narrator sentence tells the story of the moment. No jargon on screen.
3. **One job per element.** If two elements say the same thing, one of them
   is deleted. If an element only matters at a certain moment, it exists only
   then (the flight-day checklist shows only while armed at the gate).
4. **Stillness.** The layout never jumps — fixed-height narrator, damped
   camera, fades instead of pops.
5. **The real world.** The ground under the plane is the actual earth of the
   corridor — real map tiles, the real sun angle, real geography.

## The system

- **Colors** — background `#050505` · foreground `#e6e1d6` · dim `#5c574e` ·
  faint `#35322c` · accent `#ffb454` (the only warm thing on screen) ·
  hairlines `rgba(230,225,214,.10)`
- **Type** — ui-monospace / SF Mono, wide-tracked uppercase for chrome,
  lowercase for content, tabular numerals for values
- **Layout (portrait phone)** — header (status · position) → the scene
  (flex-fills) → narrator (fixed 44 px, one or two lines) → metrics grid
  (2×2: speed / altitude / outside / wind, each value + unit + caption) →
  checklist (armed only) · attribution (8 px, bottom right)
- **Scene** — flat-shaded A320 with amber edge lines, chase camera 100 m
  behind and 42 m above, damped (0.14/frame, snaps beyond 2 km), sun-shaded
  from the real position (clamped to 20° so night demos read), dark earth
  tiles with fog fade at the horizon, amber route line beneath
- **Motion** — 25 fps scene, 10 Hz DOM, overlay/report fades 0.35 s

## Requirements → implementation

| The user asked | The build |
|---|---|
| "incredible minimalistic UI" | § colors, type, one accent, zero decoration |
| "the model the main centre… no different modes… easy to look… no redundancy" | § principle 1, 3; the dial/toggle/chart were deleted; wind spoken once |
| "cool stuff and cool metrics… in a human understandable way" | captions + narrator, e.g. *954 km/h → 3× faster than a bullet train* |
| "make it resemble the actual location and earth" | 122 real map tiles of BRS→SVQ, brightened for OLED, cached offline |
| "why's the plane so zoomed out" | camera 130 m → 100 m; wingspan 85 px → 111 px, measured |

## Verified

Every frame of the demo captured and checked: runway (airport tiles), rotation,
climb, banked turns, cruise (plane over textured earth, route line beneath),
descent, flare. Full functional suite green: live-flight simulation, report
card, attitude self-calibration. The one judgement a rig can't make is taste —
that verification belongs to the user's eyes on the OLED iPhone.
