# Aurora Borealis — real-time WebGL 2 simulation

A ground-level view of the northern lights, rendered entirely in WebGL 2
fragment shaders. There are no image textures, models or video: the curtains,
stars, Milky Way, mountains, lake and snow are generated procedurally every
frame.

![Aurora over a mountain horizon](preview.jpg)

## Run it

The page is a static site with classic `<script>` tags, so there is no build
step.

- **Simplest:** open `index.html` in a browser. Everything is local; nothing is
  fetched from the network.
- **Or serve the folder** (recommended if the browser is strict about `file://`):

  ```sh
  python -m http.server 8123 --bind 127.0.0.1
  # then open http://127.0.0.1:8123/
  ```

Requires a WebGL 2 browser with 3D texture support (current Chrome, Edge,
Firefox and Safari all qualify). HDR rendering uses `EXT_color_buffer_float`
when available and falls back to 8-bit targets automatically.

## What the simulation models

The visual state is driven by a small space-weather model in `js/physics.js`
rather than by hand-animated brightness curves.

```
solar wind (speed, density, IMF Bz)
        │
        ▼
dayside reconnection coupling
        │
        ▼
magnetospheric energy storage
        │
        ▼
substorm onset ──► particle precipitation ──► atmospheric emission
```

- **Solar wind** speed, density and `Bz` vary on several slow sine periods.
  Southward `Bz` and high speed raise the coupling proxy.
- **Substorm cycle**: `QUIET → GROWTH → EXPANSION → RECOVERY`.
  Energy builds during growth, releases quickly at expansion onset, then decays
  through recovery. The HUD shows the current phase. The first substorm begins
  **24–32 seconds** after load; later ones follow **42–72 seconds** after the
  previous recovery. The button can start a substorm or add a surge to a
  running one.
- **Four visual signals** leave the model and reach the renderer:
  - `activity` — the fast emission signal (green oxygen).
  - `activitySlow` — a slower signal with a longer time constant, used for the
    630.0 nm red layer because the O(1D) state has a much longer radiative
    lifetime than the green 557.7 nm state.
  - `energy` — a precipitation-hardness proxy that raises nitrogen blue/violet
    emission at the base of the curtain.
  - `surge` — the substorm envelope, which also contracts the sheet stack
    slightly to suggest the expanding oval.
- **Background colours** follow the dominant auroral lines: 557.7 nm oxygen
  green through the body of the curtain, 630.0 nm oxygen red in the high,
  diffuse top, and N2 / N2+ blue-violet confined to the base of the column,
  where harder precipitation actually reaches. The red layer is intentionally
  less ray-structured than the green, because it comes from a higher and more
  uniform emission altitude.
- **Geometry**: up to four near-vertical, east–west aligned sheets between
  roughly 82 and 500 km altitude. Their lower edges form the bright arcs; folds,
  altitude-dependent meanders and a magnetic-field-like lean make them read as
  curtains rather than flat walls.
- **Arc scale**: the whole stack shares one gap pattern, so the curtain breaks
  into discrete arcs with darker gaps instead of averaging back into a
  continuous wall. The gaps deepen as geomagnetic activity rises and the sheet
  heights differ from arc to arc, so the upper edge undulates.

The result is physically ordered, but it is an artistic model, not a forecast,
a magnetohydrodynamic simulation or a radiative-transfer solution.

## Rendering pipeline

All passes use one fullscreen triangle and no per-frame allocations.

| # | Pass | Target | What it does |
|---|------|--------|--------------|
| 1 | Aurora volume | 0.34–0.9× canvas, `RGBA16F` | Solves each camera ray against up to four warped curtain sheets, composites them front-to-back. |
| 2 | Bloom extract | 1/2 resolution | Thresholds the aurora with a soft knee so only bright curtain cores bloom. |
| 3 | Separable blur | 1/2 and 1/4 resolution | Two Gaussian H/V pairs at different scales. |
| 4 | Scene composite | canvas | Procedural sky, airglow, stars, Milky Way, aurora, two-scale bloom, mountains, snow, lake reflection, ACES tone mapping, grain, vignette. |

Only the aurora feeds bloom, so stars, terrain and water stay clean while bright
curtains gain a soft atmospheric halo.

### The curtain model

A naive raymarch through a thin sheet aliases badly: the fine ray structure
changes between samples, producing salt-and-pepper pixels. The renderer instead
solves for the ray's intersection with each sheet:

1. Define the sheet surface depth
   `z(x, y, t) = z0 + bow·(x/z0)² + meander(y) + fold(x, y, t) + lean(y)`.
2. Iterate `t ← (z(x(t), y(t), t) − camZ) / rd.z` three times. This converges on
   the point where the camera ray crosses the warped sheet.
3. Evaluate all curtain structure once at that point: large-scale flow,
   altitude-dependent snake, folds, arc-scale envelope, vertical field-aligned
   rays, nitrogen foot and altitude profile.
4. Multiply by the analytic line integral of the sheet's Gaussian
   cross-section:

   ```
   ∫ ρ(s) ds = √π · width / |sRate|
   ```

   where `sRate = rd.z − (dz/dy) · rd.y / altSpan` accounts for the ray crossing
   the sheet at a slant.
5. Sort the four sheets by distance and composite front to back with
   `T *= exp(−τ·absorb)`. This gives overlapping layers real depth while
   remaining cheap.

A second, much wider Gaussian is composited as an optically thin luminous halo
around each sheet. It supplies the diffuse glow that the unresolved part of a
real curtain produces, without another render pass.

### Arc-scale organisation

Without organisation the stack reads as one continuous wall: four sheets each
fill the frame, and any per-sheet gap is covered by the sheet behind it.

- A gap field `bands` is sampled at `rd.x · uBaseZ`, on one reference plane
  instead of at each sheet's own depth. All sheets therefore break at the same
  screen position, and the arc stays coherent when the camera turns.
- Two slow sines with wavelengths of roughly 280 km and 120 km give a handful
  of arcs across the view. (Sampling in the sheet's world coordinates with a
  longer wavelength put half a cycle across the whole frame, which reads as a
  single dark third rather than as arcs.)
- The gap floor rises from 0.62 in quiet conditions to 0.20 at high activity:
  quiet arcs are broad and fairly uniform, and activity is what splits the oval
  into discrete arcs. The arc height varies with the same field, so the bright
  bands are taller and the gaps shorter.
- Each sheet also fades in and out over several minutes (`vis`, 0.62–1.0), which
  keeps the stack changing without adding layers.
- A slow wave travelling along the arc (`w3`, ~1.4·10⁻³ rad/km) makes
  neighbouring filaments move together, instead of each one breathing in place.

The lower border is drawn as an edge rather than a fade: emission rises over
about 8 km, a narrow broken rim of extra density sits just above the base, and
the halo no longer bleeds below the sheet base. The rim reuses the arc, ray and
envelope masks, so the sharper base costs no additional noise fetches.

Because each sheet is integrated analytically, the image is essentially free of
step aliasing. The quality setting therefore controls detail (`uSteps`, which
drives the fold amplitudes, the optional fine octave and a width compensation),
not a sample loop.

### Procedural noise

`js/noise.js` builds a tileable 64³ RGBA8 value-noise volume on the CPU once at
startup. Each channel has its own lattice period (`4, 8, 16, 8`), so a single
trilinear fetch returns large, medium and fine scales at once. The texture is
mipmapped and repeats on all axes. Time animation scrolls the W coordinate, and
domain warping uses one channel to displace the sampling of another.

The same volume is reused by the scene pass for the Milky Way dust, mountain
facets, snow and water ripples.

### Sky, terrain and water

- The sky is a deep blue gradient with a subtle airglow layer that brightens
  with geomagnetic activity.
- Stars are hashed per direction cell in two layers with different density and
  size; they twinkle slowly and sit behind the additive aurora.
- The Milky Way is a Gaussian band around a fixed axis, modulated by noise dust.
- Mountains use ridged azimuthal noise at two frequencies, converted to an
  elevation silhouette with anti-aliased edges. Their upper slopes and snow
  faces pick up a restrained green rim from the aurora.
- Snow fields use noise mottling and a low green reflection near the horizon.
- A frozen lake in the foreground mirrors the modelled aurora. The reflection
  is projected from the reflected camera ray into the aurora buffer; ripple
  distortion and a modest vertical stretch are artistic, not ray-traced.
- The final image is exposed, ACES tone mapped, lightly graded, converted to
  sRGB, vignetted and given fine grain.

## Controls

| Control | Range | Effect |
|---|---|---|
| Aurora intensity | 0–2 | Global emission multiplier. |
| Turbulence | 0.2–2 | Amplitude and contrast of folds and fine filaments. |
| Curtain density | 0.15–1 | Opacity, sheet absorption and number of active layers (2–4). |
| Emission altitude | 0–1 | Shifts the green/blue/red palette up or down. |
| Simulation speed | 0–3× | Speed of the space-weather clock and curtain flow. |
| Exposure | 0.4–2.2 | Filmic exposure before tone mapping. |
| Trigger substorm | button | Starts a growth phase, or adds a surge to a running substorm. |
| Pause | button | Freezes simulation time (camera drift and water continue). |
| Auto camera | toggle | Slow cinematic yaw/pitch sway. |
| Reset view | button | Returns to the default framing. |
| Quality | button | Cycles Low → Medium → High → Ultra. |
| Adaptive resolution | toggle | Lowers resolution/detail if FPS drops; restores it when there is headroom. |

Keyboard: `Space` pause, `S` substorm, `R` reset view, `Q` cycle quality,
`H` hide all UI. Drag to look, scroll or pinch to zoom, double-click to reset.
The camera uses damped follow and a short decaying flick after a drag; with
`prefers-reduced-motion: reduce` the automatic drift starts off.

If the WebGL context is lost, the page stops rendering and offers a reload
instead of throwing every frame.

## URL parameters

Development and review helpers:

| Parameter | Example | Effect |
|---|---|---|
| `quality` | `?quality=medium` | Start at a named quality tier. |
| `scale` | `?scale=0.6` | Override aurora buffer scale (0.24–1.0). |
| `steps` | `?steps=40` | Override detail level (16–96). |
| `noauto` | `?noauto` | Disable adaptive resolution. |
| `capture` | `?capture=1` | `preserveDrawingBuffer`, for canvas screenshots. |
| `ldr=1` | `?ldr=1` | Force 8-bit targets even when float buffers exist. |

## Tuning

All live defaults and world constants are in `js/config.js`.

### World and camera

| Key | Default | Meaning |
|---|---|---|
| `world.baseAlt` | `82` km | Lower edge of the green emission layer. |
| `world.topAlt` | `252` km | Nominal top of the bright green/red column. |
| `world.slabTop` | `500` km | Highest modelled red emission (faint sheet tops). |
| `world.nearZ`, `farZ` | `300`, `940` km | Depth range of the auroral slab. |
| `world.halfWidth` | `1700` km | Half extent of the slab across the view. |
| `world.curtainBaseZ` | `430` km | Depth of the first sheet. |
| `world.curtainSpacing` | `150` km | Depth gap between sheets. |
| `camera.pitch` | `0.30` rad | Default elevation above the horizon. |
| `camera.fov` | `61°` | Default vertical field of view. |

The four sheets therefore sit at 430, 580, 730 and 880 km, all inside the
940 km far plane. The shader receives these bounds as uniforms, so `config.js`
is the single source of truth.

### Bloom and quality

| Key | Default | Meaning |
|---|---|---|
| `bloom.threshold` | `0.72` | Linear HDR threshold for bloom extraction. |
| `bloom.knee` | `0.50` | Soft cut width around the threshold. |
| `bloom.strength` | `0.66` | Weight of the 1/2-resolution bloom. |
| `bloom.wideStrength` | `0.36` | Weight of the 1/4-resolution bloom. |
| `quality.low` | `0.34`, `34` | Aurora scale and detail level. |
| `quality.medium` | `0.46`, `46` | |
| `quality.high` | `0.58`, `60` | Default. |
| `quality.ultra` | `0.72`, `76` | |

Each tier also has a `maxScale` used by adaptive quality when there is
performance headroom.

### Shader parameters

The aurora shader (`js/shaders/aurora.js`) receives:

| Uniform | Meaning |
|---|---|
| `uIntensity`, `uTurbulence`, `uDensity` | UI parameters. |
| `uColorBias` | Emission-altitude palette shift. |
| `uActivity`, `uActivitySlow` | Fast green and slow red emission signals. |
| `uEnergy` | Precipitation-hardness proxy (blue/violet weight). |
| `uSurge` | Substorm envelope and sheet-stack contraction. |
| `uFlow` | Flow-speed multiplier for the noise scroll. |
| `uSteps` | Detail quality: fold amplitude, fine octave and sheet width. |
| `uLayers` | Number of active curtain sheets (2–4). |
| `uWidthScale` | Compensates fewer detail levels with slightly wider sheets. |
| `uBaseAlt`, `uAltSpan`, `uSlabTop` | Altitude mapping of the modelled slab. |
| `uBaseZ`, `uSpacing` | Sheet depths. |
| `uNearZ`, `uFarZ`, `uHalfWidth` | Slab bounds. |
| `uNoise` | The 64³ RGBA noise volume. |

Notable constants and derived quantities inside the shader:

- `gainBase = 0.060 · intensity · (0.62 + 0.80·activity + 0.28·surge)` —
  overall emission gain.
- `absorb = 0.014 · (0.35 + 0.9·density)` — per-layer optical depth.
- `foldAmp ≈ 24–58 km`, plus a 12–42 km fine term — depth displacement of the
  curtain folds.
- `bow = (42 + 16·layer)·(x / 1.6·z0)²` km — recedes the sheet towards the frame
  edges so the arc sweeps up in the middle.
- `lean = v·(16 + 15·noise)` km — height-dependent tilt of the field lines.
- Base ray frequency `0.024`, optional fine octave at `0.082`.
- `bands` — shared arc-gap field (wavelengths ≈ 280 and 120 km), sampled on the
  reference plane; `gapFloor = mix(0.62, 0.20, activity)` is how far a gap
  darkens the sheet.
- `w3 = x·0.00145 − t·0.0035·flow` — the slow wave travelling along each arc.
- `emission()` holds the 557.7 / 630.0 / N2 / N2+ weights and the altitude
  profiles; it is not a spectral render.

Scene-side parameters live in `js/shaders/scene.js` (star layers, Milky Way
axis, ridge frequencies `6.0/9.0`, lake reflection, grading); the star tuning
and bloom weights are in `js/config.js`.

## Performance notes

- The aurora volume runs at 34–90 % of canvas resolution. Its detail is soft,
  so this is nearly invisible after upsampling and bloom.
- The canvas is capped at ~3.7 megapixels and DPR 1.75 to bound fill cost.
- Bloom is evaluated at 1/2 and 1/4 resolution.
- The 3D noise texture is mipmapped and generated once; no allocations occur
  per frame.
- Adaptive quality reduces the aurora scale and detail when FPS falls below
  ~47, and recovers when FPS exceeds ~58.
- If `requestAnimationFrame` is throttled to a standstill (some embedded
  panels), a timer-driven fallback keeps the simulation running.
- The lake reflection adds three texture fetches in the scene pass (aurora plus
  the two bloom scales), not a second aurora render.

### Measured frame cost

`tools/bench.mjs` renders the pipeline directly and waits on each frame (a
1×1 `readPixels` acts as a fence), so the numbers below exclude weather,
camera and DOM work but include the full-res scene composite, bloom and the
synchronisation wait. Headless Chrome runs on SwiftShader, so the absolute
values are a proxy only; use them to compare builds at the same size and tier.

| Build / tier | Median | Notes |
|---|---|---|
| high, 1258×702, 2 layers | 432 ms | → ~56 ms per extra layer |
| high, 1258×702, 4 layers | 545 ms | default density |
| low, 0.34 scale | 368 ms | |
| high, 0.58 scale | 540 ms | |
| ultra, 0.72 scale | 665 ms | |

The scene composite at full canvas resolution plus the fence is roughly 310 ms
of that, so the aurora pass itself is about 230 ms at the high tier here.
Halving the layer count saves about 21 % of the frame; one layer is worth about
10 %. That is what the 2–4 layer range from the density slider buys, and why
adaptive quality lowers resolution before it touches the layer count.

A build that skipped the third convergence iteration on the high tier landed
inside run-to-run noise (545 ms vs 641 ms medians over 30 frames, with a ±15 %
spread), so it was reverted: no reproducible gain, and the extra iteration
keeps the steep folds placed correctly. The same applies to dropping the fine
ray octave; the real lever is the buffer scale, which the tiers already set.

## Files

```
index.html              markup, UI, error and context-loss overlays
css/style.css           visual design, responsive layout, reduced motion
js/config.js            world, camera, quality, bloom and noise defaults
js/noise.js             tileable 3D value-noise generator
js/physics.js           solar wind → coupling → storage → substorm state machine
js/camera.js            damped look controls, inertia, pinch zoom, drift
js/gl.js                programs, render targets, noise texture helpers
js/shaders/common.js    fullscreen triangle, hashes, ACES, sRGB
js/shaders/aurora.js    closest-approach curtain volume and emission model
js/shaders/post.js      bloom extract, blur, downsample
js/shaders/scene.js     sky, stars, aurora composite, terrain, lake, grade
js/renderer.js          render pipeline and target management
js/ui.js                DOM controls and keyboard shortcuts
js/main.js              boot, frame loop, adaptive resolution, context loss
tools/shot.mjs          headless Chrome screenshot harness (development only)
tools/bench.mjs         headless frame-cost benchmark (development only)
```

## Development harness

`tools/shot.mjs` drives headless Chrome over the DevTools protocol and saves
either the canvas or the full page. It expects Chrome at
`C:\Program Files\Google\Chrome\Application\chrome.exe`; adjust `chromePath` for
another platform.

```sh
# canvas only
node tools/shot.mjs "http://127.0.0.1:8123/?v=106&quality=high&noauto&capture=1" shot.png 1200

# full page, including the control panel
$env:SHOT_PAGE="1"           # PowerShell
node tools/shot.mjs "http://127.0.0.1:8123/?v=106" page.png 1200
```

Other environment variables: `SHOT_SIZE` (`1200,760`), `SHOT_EVAL` (JavaScript
run before capture), `SHOT_EVAL_WAIT` (ms), `SHOT_EMULATE` (`390x780`, applies
mobile emulation and reloads), `SHOT_DPR`.

The version query string (`?v=106`) is only cache busting and can be omitted in
normal use.

### Frame-cost benchmark

`tools/bench.mjs` measures render cost without depending on the browser's
animation-frame scheduling (headless Chrome throttles `requestAnimationFrame`,
which makes frame-gap timing useless):

```sh
node tools/bench.mjs "http://127.0.0.1:8123/?capture=1" high 30
$env:BENCH_LAYERS="2"; node tools/bench.mjs "http://127.0.0.1:8123/?capture=1" high 30
```

It sets the tier, disables auto camera and adaptive quality, then renders the
pipeline N times and forces each frame with a 1×1 `readPixels` fence. Compare
medians from the same machine and window size; the p95 spread is large on
SwiftShader. `BENCH_LAYERS` overrides the layer count to isolate per-layer cost.

### Repeatable state captures

The model is time-driven, so a headless capture can be placed in a known state
with `SHOT_EVAL`:

```powershell
# expansion-phase curtain
$env:SHOT_EVAL=@'
const w = window.__aurora.weather;
w._enter(2, 40); w.phaseT = 9; w.env = 0.95; w.surge = 0.9;
w.activity = 0.95; w.activitySlow = 0.9; w.energy = 0.8; w.stored = 0.8;
'@
$env:SHOT_EVAL_WAIT="2500"
node tools/shot.mjs "http://127.0.0.1:8123/?quality=high&noauto&capture=1" growth.png 2500
```

Useful states: `_enter(0, 0)` quiet, `_enter(1, 8)` growth, `_enter(2, 40)`
expansion, `_enter(3, 30)` recovery. Set the visual fields as well when a capture
must not wait for smoothing. Automatic captures were taken at quiet, growth,
expansion, recovery, high activity, alternate angles, all four quality tiers and
a 390×780 mobile viewport.

For a before/after comparison the model must not advance between the two runs,
so freeze it completely: same phase, paused clock, fixed `simTime` (which is the
shader's `uTime`), fixed camera, and a no-op weather update.

```powershell
$env:SHOT_EVAL=@'
const A = window.__aurora, w = A.weather, c = A.camera;
w._enter(2, 40); w.phaseT = 9; w.env = 0.95; w.surge = 0.9;
w.activity = 0.95; w.activitySlow = 0.9; w.energy = 0.8; w.stored = 0.8;
w.update = function () {};
A.params.paused = true; A.state.simTime = 124; A.state.realTime = 124;
c.setAuto(false); c.baseYaw = 0; c.yaw = 0; c.basePitch = 0.02; c.pitch = 0.02;
c.velYaw = 0; c.velPitch = 0; c.spinYaw = 0; c.spinPitch = 0;
'@
$env:SHOT_EVAL_WAIT="1500"
node tools/shot.mjs "http://127.0.0.1:8123/?capture=1&quality=high" after.png 3500
```

Run the same command against a checkout of the previous commit (`git worktree
add ../aurora-base HEAD --detach`, served on another port) to get a true A/B with
identical camera, weather and noise phase.

## Modelled vs artistic

| Modelled / physically ordered | Artistic approximation |
|---|---|
| Solar-wind speed, density and `Bz` drive a coupling proxy. | The sine periods and amplitudes are illustrative, not measured solar-wind data. |
| Substorm phases and stored energy are a state machine. | Phase durations and the 24–32 s / 42–72 s scheduling are chosen for viewing, not derived from observations. |
| Emission is weighted by altitude for 557.7 nm OI, 630.0 nm OI and N2/N2+ bands. | The weights are display-space colours, not a spectral or radiative-transfer calculation. |
| The red layer follows a slower signal than the green layer. | The two time constants approximate the O(1D) lifetime; they are not solved from chemistry. |
| Near-vertical sheets lean and meander like field-aligned curtains. | The sheets are Gaussian surfaces with artistic folds; no magnetic-field integration is performed. |
| The oval contracts during a substorm. | It is represented by a small depth shift of the sheet stack, not a mapped auroral oval. |
| Front-to-back absorption gives overlapping arcs depth. | Optical depth is a single scalar per layer. |
| Arc gaps and the travelling wave are shared across the sheet stack, so arcs stay coherent with depth and with camera motion. | Gap spacing, travel speed and the activity dependence are chosen for appearance, not fitted to a mapped oval. |
| The lake reflects the modelled sky through a reflected camera ray. | Ripple distortion, vertical stretch and brightness are stylised for the shot. |
| Bloom and ACES produce a filmic image. | These are display transforms, not instrument response. |

## Limitations

- No live or historical space-weather data is fetched. The HUD values are
  modelled proxies and are labelled as such.
- No magnetohydrodynamics, particle tracing, ionospheric chemistry or
  radiative transfer is solved.
- The camera is fixed at the origin; there is no terrain-scale fly-through.
- Arc organisation is a procedural gap field, not a mapped auroral oval: the
  spacing does not follow a real geomagnetic latitude or field-line geometry.
- The lake reflection is screen-space and only contains the aurora buffer, not
  the stars or mountains.
- The renderer favours a coherent, low-cost approximation over measured
  radiometry. Different solar-wind conditions will not reproduce a specific
  real event.
- Headless Chrome uses SwiftShader, so the review harness runs at only a few
  frames per second even though hardware browsers are much faster.
