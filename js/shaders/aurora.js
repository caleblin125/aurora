/* ------------------------------------------------------------------
   Volumetric aurora curtains.

   The aurora is represented as a small set of near-vertical sheets inside
   a 82-500 km atmospheric slab.  Each sheet is a narrow Gaussian in depth
   whose surface is displaced by large-scale flow noise, altitude-dependent
   meanders, folds and a magnetic-field-like lean.  The sheets are placed at
   different depths, so a near arc hides parts of the arcs behind it and the
   layer stack reads as an actual volume with parallax and extinction.

   The curtain is also organised at arc scale.  All sheets sample one gap
   pattern on a reference plane, so they break into the same discrete arcs
   with darker gaps instead of averaging back into a continuous wall, and the
   gap pattern deepens with geomagnetic activity.  A slow wave travels along
   each arc, so neighbouring filaments move together rather than each one
   breathing in place.

   Instead of marching through each thin sheet (which aliases the fine ray
   structure), the shader solves for the camera ray's closest approach to the
   sheet, evaluates all curtain structure there once, and multiplies by the
   analytic line integral of the Gaussian cross-section.  A second, much
   wider Gaussian is composited as an optically thin luminous halo, giving the
   broad glow around a curtain without another render pass.

   Emission is a sum of oxygen and nitrogen line contributions, weighted by
   altitude and by the simulated precipitation energy.  The 557.7 nm green
   follows the fast activity signal; the 630.0 nm red upper layer follows a
   slower signal because the O(1D) state has a much longer radiative lifetime.
   Nitrogen blue/violet is confined to the base of the column, where harder
   precipitation actually reaches.  These are approximations of the dominant
   lines, not a radiative-transfer solution.
   ------------------------------------------------------------------ */
(function () {
  "use strict";
  const Aurora = (window.Aurora = window.Aurora || {});
  const S = (Aurora.Shaders = Aurora.Shaders || {});

  S.aurora = `#version 300 es
precision highp float;
precision highp sampler3D;

uniform sampler3D uNoise;
uniform vec3 uCamPos;
uniform vec3 uFwd;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uTanHalf;
uniform float uAspect;
uniform float uTime;
uniform float uFlow;
uniform float uIntensity;
uniform float uTurbulence;
uniform float uDensity;
uniform float uColorBias;
uniform float uActivity;
uniform float uActivitySlow;
uniform float uEnergy;
uniform float uSurge;
uniform float uWidthScale;
uniform int uSteps;
uniform int uLayers;
uniform float uBaseAlt;
uniform float uAltSpan;
uniform float uBaseZ;
uniform float uSpacing;
uniform float uNearZ;
uniform float uFarZ;
uniform float uHalfWidth;
uniform float uSlabTop;

in vec2 vUv;
out vec4 fragColor;

/* The dominant lines, expressed as approximate display-space colours.
   Oxygen green 557.7 and red 630.0 dominate; N2+ 427.8 and the N2 LBH
   bands supply the blue/violet lower border.  The display values are pulled
   slightly off the pure spectral colours: real aurora photographs show a
   softer, less electric green and a salmon rather than a magenta red. */
const vec3 C_GREEN  = vec3(0.16, 0.93, 0.42);
const vec3 C_RED    = vec3(1.00, 0.32, 0.27);
const vec3 C_BLUE   = vec3(0.16, 0.30, 1.00);
const vec3 C_VIOLET = vec3(0.44, 0.24, 1.00);

/* Altitude profiles in slab units (v = 0 at 82 km, v = 1 at 252 km).
   The green layer is broad in the column but fades above ~200 km, the red
   layer lives above it, and nitrogen emission hugs the lower border. */
vec3 emission(float v, float ray, float energy, float slow, float bias) {
  float alt = v + (bias - 0.38) * 0.26;

  float greenP = smoothstep(-0.05, 0.06, alt) * (1.0 - smoothstep(0.58, 1.18, alt));
  float redP   = smoothstep(0.95, 1.40, alt) * (1.0 - smoothstep(1.90, 2.55, alt));
  float blueP  = exp(-pow((alt - 0.015) / 0.070, 2.0));
  /* Violet belongs to the very base of the column, not the mid-altitude body. */
  float violP  = smoothstep(0.01, 0.09, alt) * (1.0 - smoothstep(0.20, 0.42, alt));

  float greenW = 1.00;
  float redW   = 0.05 + 0.20 * slow;
  float blueW  = 0.02 + 0.26 * energy;
  float violW  = 0.02 + 0.20 * energy;

  vec3 em = C_GREEN * (greenP * greenW)
          + C_RED   * (redP   * redW)
          + C_BLUE  * (blueP  * blueW)
          + C_VIOLET* (violP  * violW);

  /* Bright filaments desaturate a little, as exposed film does.  Kept low so
     the cores stay green instead of burning to white. */
  float peak = max(max(em.r, em.g), em.b);
  em = mix(em, vec3(0.90, 1.00, 0.95) * peak, ray * ray * 0.06);
  return em;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uFwd + uRight * (ndc.x * uTanHalf * uAspect) + uUp * (ndc.y * uTanHalf));
  vec3 ro = uCamPos;

  /* Slab intersection.  The top is high enough for the far sheets to reach
     the faint 630 nm red layer, which is what gives distant arcs their tops. */
  vec3 bmin = vec3(-uHalfWidth, uBaseAlt, uNearZ);
  vec3 bmax = vec3(uHalfWidth, uSlabTop, uFarZ);
  vec3 inv = 1.0 / rd;
  vec3 ta = (bmin - ro) * inv;
  vec3 tb = (bmax - ro) * inv;
  vec3 tlo = min(ta, tb);
  vec3 thi = max(ta, tb);
  float tn = max(max(tlo.x, tlo.y), max(tlo.z, 0.0));
  float tf = min(min(thi.x, thi.y), thi.z);
  if (tf <= tn || rd.z < 0.12) {
    fragColor = vec4(0.0);
    return;
  }

  float gainBase = 0.060 * uIntensity * (0.62 + 0.80 * uActivity + 0.28 * uSurge);
  float absorb = 0.014 * (0.35 + 0.9 * uDensity);
  float turb = uTurbulence;
  float flow = uFlow;
  /* Quality knob: finer filament detail and a wider anti-alias footprint at
     low settings.  It no longer controls a per-pixel sample count. */
  float detail = clamp(float(uSteps) / 44.0, 0.55, 1.35);

  float tHit[4];
  vec3 hitCol[4];
  float hitDen[4];
  vec3 glowCol[4];
  float glowDen[4];

  for (int k = 0; k < 4; k++) {
    tHit[k] = 1e9;
    hitCol[k] = vec3(0.0);
    hitDen[k] = 0.0;
    glowCol[k] = vec3(0.0);
    glowDen[k] = 0.0;
  }

  for (int k = 0; k < 4; k++) {
    if (k >= uLayers) break;
    float fi = float(k);

    /* The oval contracts towards the observer during a substorm: the whole
       stack moves a little closer, which changes apparent scale and parallax
       without moving the camera. */
    float depthCenter = uBaseZ + fi * uSpacing - uSurge * 18.0;

    /* ---- closest approach of the ray to this sheet ---- */
    float t = clamp(depthCenter, tn, tf);
    vec3 p = ro + rd * t;
    float v = (p.y - uBaseAlt) / uAltSpan;
    vec4 w = vec4(0.5);
    vec4 d = vec4(0.5);
    float fold = 0.0;
    float lean = 0.0;
    float waveSlope = 0.0;

    for (int it = 0; it < 3; it++) {
      /* Altitude-dependent meander.  Displacing the sheet in depth alone is
         invisible head-on, so the same offset also warps the sampling of the
         fine structure below; that is what makes a curtain snake and fold as
         it rises instead of reading as a picket fence. */
      float snake = v * (38.0 + 10.0 * fi)
                  + sin(v * 2.30 + p.x * 0.0022 + uTime * 0.045 * flow + fi * 1.9) * 22.0
                  + sin(v * 5.10 - p.x * 0.0031 + uTime * 0.088 * flow + fi * 3.7) * 9.0;
      float xw = p.x + snake + fi * 151.0;
      vec3 wq = vec3(
        p.x * 0.0050 + 0.17,
        v * 0.14,
        uTime * 0.0034 * flow + 0.63
      );
      w = texture(uNoise, wq);
      vec3 dq = vec3(
        xw * 0.0062 + (w.r - 0.5) * 0.14 + uTime * 0.0033 * flow,
        v * 0.16 + fi * 0.41 + (w.g - 0.5) * 0.12,
        uTime * 0.019 * flow + fi * 3.71
      );
      d = texture(uNoise, dq);

      float foldAmp = 24.0 + 34.0 * turb;
      fold = (w.r - 0.5) * 2.0 * foldAmp
           + (w.g - 0.5) * 2.0 * foldAmp * 0.38
           + (d.r - 0.5) * (12.0 + 30.0 * turb);
      lean = v * (16.0 + 15.0 * d.g);

      /* Altitude-dependent meanders bend the sheet into S-folds when seen
         edge-on.  Their slope participates in the line integral below. */
      float w1 = p.x * 0.0082 + v * 2.6 + uTime * 0.055 * flow + fi * 1.7;
      float w2 = p.x * 0.0195 - v * 1.4 + uTime * 0.120 * flow + fi * 3.3;
      /* A slow wave travelling along the arc keeps neighbouring filaments
         moving together instead of each one breathing in place. */
      float w3 = p.x * 0.00145 - uTime * 0.0035 * flow + fi * 2.2;
      float waveAmp = 0.35 + 0.65 * turb;
      float wave = (sin(w1) * 11.0 + sin(w2) * 5.0 + sin(w3) * 12.0) * waveAmp;
      waveSlope = (cos(w1) * 11.0 * 2.6 + cos(w2) * 5.0 * -1.4
                 + cos(w3) * 12.0 * 0.00145)
                * waveAmp / uAltSpan;

      /* Arcs are not flat walls: the sheet recedes towards the frame edges
         so the band sweeps up in the middle, and the background arcs use a
         slightly different curvature so they do not stack exactly. */
      float xr = p.x / max(uBaseZ * 1.6, 1.0);
      float bowAmp = 42.0 + 16.0 * fi;
      float zc = depthCenter + bowAmp * xr * xr + wave
               + sin(uTime * 0.0091 * flow + fi * 2.3) * 9.0;
      t = (zc + fold + lean - ro.z) / rd.z;
      if (it < 2) {
        t = clamp(t, tn, tf);
        p = ro + rd * t;
        v = (p.y - uBaseAlt) / uAltSpan;
      }
    }
    t = clamp(t, tn, tf);
    p = ro + rd * t;
    v = (p.y - uBaseAlt) / uAltSpan;
    if (v < -0.06 || v > 2.42) continue;

    /* ---- shared large-scale flow (one fetch, four scales) ---- */
    float warpA = (w.r - 0.5) * 2.0;
    float warpB = (w.g - 0.5) * 2.0;
    float warpC = (w.b - 0.5) * 2.0;
    float warpD = (w.a - 0.5) * 2.0;

    /* Arcs are coherent across the depth stack, so the gap pattern is sampled
       on one reference plane instead of per-sheet depth: otherwise each
       sheet's gaps fall in different places and average back into a wall.
       At the sheet depth the frame spans under 1 Mm, so a 250-300 km
       wavelength gives a handful of arcs rather than half of one. */
    float arcX = rd.x * uBaseZ;
    float arcBig = 0.5
                 + 0.34 * sin(arcX * 0.0225 + uTime * 0.020 * flow + fi * 0.35)
                 + 0.15 * sin(arcX * 0.0510 - uTime * 0.031 * flow + fi * 0.90);
    float bands = smoothstep(0.30, 0.66, arcBig * 0.82 + (warpD * 0.5 + 0.5) * 0.18);
    /* Quiet arcs are broad and fairly uniform; activity is what splits the
       oval into discrete arcs, so the gaps deepen with the activity signal. */
    float gapFloor = mix(0.62, 0.20, smoothstep(0.10, 0.85, uActivity));

    /* Sheets fade in and out over several minutes, so the stack keeps
       changing without adding more layers. */
    float vis = 0.62 + 0.38 * smoothstep(
      -0.6, 0.6, sin(uTime * 0.012 * flow + fi * 2.1) * 0.7 + 0.3
    );

    float snake = v * (38.0 + 10.0 * fi)
                + sin(v * 2.30 + p.x * 0.0022 + uTime * 0.045 * flow + fi * 1.9) * 22.0
                + sin(v * 5.10 - p.x * 0.0031 + uTime * 0.088 * flow + fi * 3.7) * 9.0;
    float xw = p.x + snake + fi * 151.0;
    float width = (3.4 + 6.6 * d.g) * uWidthScale;

    /* Exact line integral of a Gaussian sheet along the ray. */
    float leanRate = (16.0 + 15.0 * d.g) / uAltSpan;
    float sRate = rd.z - (leanRate + waveSlope) * rd.y;
    float pathSheet = min(1.7724539 * width / max(abs(sRate), 0.06), 460.0);

    /* ---- field-aligned rays -------------------------------------------------
       Three masks combine: broad ray bundles, fine striations and darker
       lanes.  A third octave is fetched only at medium quality and above. */
    vec3 rq = vec3(
      (xw + warpA * 30.0 + warpC * 16.0 + d.a * 9.0) * 0.024 + uTime * 0.007 * flow,
      v * 0.026 + fi * 0.37,
      uTime * 0.020 * flow + fi * 6.13
    );
    vec4 r = texture(uNoise, rq);
    vec4 r2 = texture(uNoise, rq * vec3(2.17, 2.11, 1.0) + vec3(0.41, 0.13, 0.67));

    float group = smoothstep(0.30, 0.70, r.g * 0.62 + r2.r * 0.38);
    float fine = smoothstep(0.34, 0.74, r.b * 0.60 + r2.b * 0.40);
    float lanes = smoothstep(0.26, 0.70, r.a * 0.70 + r2.a * 0.30);
    float ray = group * mix(0.26, 1.0, fine) * mix(0.32, 1.0, lanes);
    ray = mix(0.05, 1.0, pow(ray, 0.95));

    if (uSteps >= 40) {
      vec3 fq = vec3(
        (xw + warpA * 34.0) * 0.082 + uTime * 0.013 * flow,
        v * 0.055 + fi * 1.21,
        uTime * 0.045 * flow + fi * 2.7
      );
      float fil = texture(uNoise, fq).b;
      ray *= 0.72 + 0.46 * smoothstep(0.28, 0.74, fil);
    }

    /* ---- arc segments, lobes and large-scale envelope ----
       One combined field instead of three multiplied smoothsteps: the old
       version averaged out to a fairly even mid grey, which is why the curtain
       read as a continuous wall.  A tighter threshold and a per-sheet phase
       offset give each sheet its own arcs and gaps. */
    float arc = smoothstep(0.42, 0.80, d.r * 0.72 + (warpC * 0.5 + 0.5) * 0.28);
    float lobe = smoothstep(-0.30, 0.60, warpB * 0.80 + (d.b - 0.5) * 0.40);
    float envField = warpD * 0.52
                   + (d.a - 0.5) * 1.05
                   + (warpC * 0.5 + 0.5) * 0.38
                   + (fi - 1.5) * 0.075;
    float env = smoothstep(-0.30, 0.34, envField);
    env = mix(0.04, 1.0, env);

    /* ---- altitude profile ---- */
    float bottom = 0.030 + 0.014 * fi + 0.010 * (d.b - 0.5) + 0.016 * warpD
                 + 0.014 * warpA
                 + (arcBig - 0.5) * 0.075
                 + 0.026 * sin(xw * 0.0105 + uTime * 0.070 * flow + fi * 1.7)
                 + 0.014 * sin(xw * 0.0247 + uTime * 0.130 * flow + fi * 4.3);
    float topBase = 1.58 + 0.30 * (warpB * 0.5 + 0.5) + 0.12 * uSurge
                  + 0.34 * sin(arcX * 0.0132 + uTime * 0.030 * flow + fi * 0.6)
                  + 0.14 * sin(arcX * 0.0291 - uTime * 0.051 * flow + fi * 2.4);
    float topScale = 1.0 + 0.12 * fi;
    float bright = clamp(ray * 0.58 + r.a * 0.32 + d.b * 0.10, 0.0, 1.0);
    /* Arcs between the bright bands are shorter as well as fainter, so the
       upper edge undulates instead of running level across the whole frame. */
    float hTop = clamp(topBase * topScale * mix(0.86, 1.14, bright)
                     * mix(0.82, 1.06, bands), 0.40, 2.32);

    /* The base is a real edge, not a fade: emission starts over ~8 km and the
       column thins upward. */
    float prof = smoothstep(bottom, bottom + 0.030, v);
    prof *= 1.0 - smoothstep(hTop * 0.78, hTop, v);
    prof *= mix(1.0, 0.45, smoothstep(bottom, hTop * 0.85, v));

    /* The 630.0 nm layer sits higher and is optically diffuse, so the fine
       ray structure fades out with altitude instead of striping the red top. */
    float rayLocal = mix(ray, 0.66, smoothstep(0.55, 1.20, v));
    float rayAmp = 0.10 + 1.66 * rayLocal;
    float sheetGain = mix(1.20, 0.45, fi / 3.0) * mix(0.80, 1.05, d.b);

    /* Patchy brightening along the curtain: rays fade in and out with altitude
       instead of running as one continuous vertical stripe. */
    float vmod = 0.42 + 0.58 * smoothstep(0.22, 0.78, w.b);
    float shape = prof * env * (0.18 + 0.82 * env) * vmod;

    /* A narrow rim of extra density just above the base draws the lower border
       as a bright, broken line instead of letting the column dissolve into
       upward flame tongues.  It reuses the arc, ray and envelope masks, so the
       defined base costs no extra noise fetches. */
    float foot = smoothstep(bottom - 0.006, bottom + 0.010, v)
               * (1.0 - smoothstep(bottom + 0.016, bottom + 0.055, v));
    foot *= smoothstep(0.24, 0.70, arc * 0.55 + rayLocal * 0.45);

    float dens = pathSheet * (shape + foot * env * 0.38)
               * (0.14 + 0.86 * arc)
               * (0.28 + 0.72 * lobe)
               * rayAmp;

    dens *= sheetGain * detail * vis;
    /* Broad gaps between arcs.  The floor keeps them dark but not black, so
       the horizon still shows faint structure between bright bands. */
    dens *= mix(gapFloor, 1.0, bands);
    if (dens <= 0.02) continue;

    /* Optically thin broad halo around the core: atmospheric diffusion and
       the unresolved part of the curtain.  It is not self-absorbed. */
    float wideWidth = width * 3.4 + 7.0;
    float pathWide = min(1.7724539 * wideWidth / max(abs(sRate), 0.06), 1200.0);
    float broad = smoothstep(bottom + 0.004, bottom + 0.070, v)
                * (1.0 - smoothstep(hTop * 0.82, hTop * 1.25, v));
    float gDen = pathWide * broad * (0.18 + 0.82 * env)
               * (0.30 + 0.70 * arc) * (0.45 + 0.55 * lobe)
               * (0.25 + 0.75 * ray) * vis * mix(0.55, 1.0, bands) * 0.030;

    vec3 c = emission(v, rayLocal, uEnergy, uActivitySlow, uColorBias);
    vec3 gc = emission(v, 0.55, uEnergy, uActivitySlow, uColorBias);

    tHit[k] = t;
    hitCol[k] = c;
    hitDen[k] = dens;
    glowCol[k] = gc;
    glowDen[k] = gDen;
  }

  /* ---- composite the layers front to back ---- */
  for (int i = 0; i < 4; i++) {
    for (int j = i + 1; j < 4; j++) {
      if (tHit[j] < tHit[i]) {
        float tt = tHit[i]; tHit[i] = tHit[j]; tHit[j] = tt;
        vec3 cc = hitCol[i]; hitCol[i] = hitCol[j]; hitCol[j] = cc;
        float dd = hitDen[i]; hitDen[i] = hitDen[j]; hitDen[j] = dd;
        vec3 gg = glowCol[i]; glowCol[i] = glowCol[j]; glowCol[j] = gg;
        float gd = glowDen[i]; glowDen[i] = glowDen[j]; glowDen[j] = gd;
      }
    }
  }

  vec3 acc = vec3(0.0);
  float trans = 1.0;
  for (int i = 0; i < 4; i++) {
    if (tHit[i] > tf) continue;
    float fog = exp(-tHit[i] * 0.00105);
    acc += trans * (hitCol[i] * hitDen[i] + glowCol[i] * glowDen[i] * 0.90)
         * gainBase * fog;
    trans *= exp(-hitDen[i] * absorb);
  }

  fragColor = vec4(acc, 1.0);
}`;
})();
