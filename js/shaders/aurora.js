/* ------------------------------------------------------------------
   Volumetric aurora curtains.

   The volume is a thin atmospheric slab (82-252 km) holding up to four
   near-vertical, warped sheets.  Each sheet is a narrow gaussian in
   depth whose horizontal position is displaced by large-scale flow
   noise, fine folds and a height-dependent lean that mimics magnetic
   field-line tilt.  Vertical rays are a separate anisotropic noise
   fetch, stretched in altitude so they read as field-aligned shafts.

   For every sheet the shader solves for the ray's closest approach,
   evaluates the curtain structure there, and multiplies it by the
   exact line integral of the gaussian cross-section.  That keeps the
   result identical at any step count and free of the salt-and-pepper
   aliasing a per-sample fetch of the fine ray noise would produce.
   Layers are then composited front to back with self-absorption, and
   colour is assigned by altitude (oxygen green/red) with nitrogen
   blue/violet mixed in through the ray structure and substorm activity.
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
uniform vec2 uResolution;
uniform float uTanHalf;
uniform float uAspect;
uniform float uTime;
uniform float uIntensity;
uniform float uTurbulence;
uniform float uDensity;
uniform float uColorBias;
uniform float uActivity;
uniform float uSurge;
uniform float uWidthScale;
uniform int uSteps;
uniform int uLayers;
uniform float uBaseAlt;
uniform float uAltSpan;
uniform float uBaseZ;
uniform float uSpacing;

in vec2 vUv;
out vec4 fragColor;

const float NEAR_Z = 300.0;
const float FAR_Z = 900.0;
const float HALF_WIDTH = 1700.0;

/* Approximate spectral colour of the dominant auroral emissions,
   blended by altitude.  Luminance is normalised roughly by eye:
   557.7 nm OI is the bright green, 630.0 nm OI the high red,
   N2+ bands provide blue and violet at the lower border. */
vec3 emissionColor(float v, float ray, float activity, float bias) {
  vec3 green  = vec3(0.16, 1.00, 0.52);
  vec3 teal   = vec3(0.08, 0.84, 0.74);
  vec3 blue   = vec3(0.16, 0.38, 1.00);
  vec3 violet = vec3(0.54, 0.26, 1.00);
  vec3 red    = vec3(1.00, 0.22, 0.13);

  float h = clamp(v * 1.06 + (bias - 0.40) * 0.58, 0.0, 1.35);

  vec3 c = green;
  c = mix(c, teal, smoothstep(0.18, 0.48, h) * 0.55);
  c = mix(c, blue, smoothstep(0.48, 0.80, h) * 0.85);
  c = mix(c, violet, smoothstep(0.70, 0.96, h) * 0.80);

  float redAmt = smoothstep(0.86, 1.14, h) * (0.18 + 0.80 * activity) * (0.35 + 0.95 * bias);
  c = mix(c, red, redAmt);

  // Energetic precipitation punches nitrogen blue into the lower rays.
  c = mix(c, vec3(0.22, 0.40, 1.00),
          smoothstep(0.55, 1.0, ray) * 0.26 * activity * (1.0 - smoothstep(0.0, 0.45, v)));

  return c;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uFwd + uRight * (ndc.x * uTanHalf * uAspect) + uUp * (ndc.y * uTanHalf));
  vec3 ro = uCamPos;

  /* Slab intersection. */
  vec3 bmin = vec3(-HALF_WIDTH, uBaseAlt, NEAR_Z);
  /* The slab reaches well above the green layer: the far sheets are
     allowed to climb into the 250-360 km red-oxygen regime so their
     tops show as a dim second arc behind the main curtain. */
  vec3 bmax = vec3(HALF_WIDTH, uBaseAlt + uAltSpan * 1.75 + 20.0, FAR_Z);
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
  /* Quality knob: extra fixed-point iterations and finer detail. */
  float detail = clamp(float(uSteps) / 44.0, 0.55, 1.35);

  float tHit[4];
  vec3 hitCol[4];
  float hitDen[4];

  for (int k = 0; k < 4; k++) {
    tHit[k] = 1e9;
    hitCol[k] = vec3(0.0);
    hitDen[k] = 0.0;
  }

  for (int k = 0; k < 4; k++) {
    if (k >= uLayers) break;
    float fi = float(k);

    /* ---- closest approach of the ray to this sheet ---- */
    float t = clamp(uBaseZ + fi * uSpacing, tn, tf);
    vec3 p = ro + rd * t;
    float v = (p.y - uBaseAlt) / uAltSpan;
    vec4 w = vec4(0.5);
    vec4 d = vec4(0.5);
    float fold = 0.0;
    float lean = 0.0;

    for (int it = 0; it < 3; it++) {
      float xw = p.x + fi * 151.0;
      vec3 wq = vec3(
        p.x * 0.0050 + 0.17,
        v * 0.14,
        uTime * 0.0034 + 0.63
      );
      w = texture(uNoise, wq);
      vec3 dq = vec3(
        xw * 0.0062 + (w.r - 0.5) * 0.14 + uTime * 0.0033,
        v * 0.16 + fi * 0.41 + (w.g - 0.5) * 0.12,
        uTime * 0.019 + fi * 3.71
      );
      d = texture(uNoise, dq);

      float foldAmp = 22.0 + 30.0 * turb;
      fold = (w.r - 0.5) * 2.0 * foldAmp
           + (w.g - 0.5) * 2.0 * foldAmp * 0.38
           + (d.r - 0.5) * (10.0 + 26.0 * turb);
      lean = v * (17.0 + 14.0 * d.g);
      /* Arcs are not flat walls: the sheet recedes towards the sides so
         the band sweeps up in the middle and sinks at the frame edges. */
      float xr = p.x / max(uBaseZ, 1.0);
      float zc = uBaseZ + fi * uSpacing + 210.0 * xr * xr
               + sin(uTime * 0.0091 + fi * 2.3) * 10.0;
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
    if (v < -0.06 || v > 1.92) continue;

    /* ---- shared large-scale flow (one fetch, four scales) ---- */
    float warpA = (w.r - 0.5) * 2.0;
    float warpB = (w.g - 0.5) * 2.0;
    float warpC = (w.b - 0.5) * 2.0;
    float warpD = (w.a - 0.5) * 2.0;

    float xw = p.x + fi * 151.0;
    float width = (5.5 + 9.0 * d.g) * uWidthScale;

    /* Direction of the sheet surface along the ray; used for the exact
       gaussian line integral (sqrt(pi) * width / |g'|). */
    float sRate = rd.z - (17.0 + 14.0 * d.g) * rd.y / uAltSpan;
    float pathSheet = min(1.7724539 * width / max(abs(sRate), 0.06), 420.0);
    float thinWidth = width * 0.30 + 0.7;
    float pathThin = min(1.7724539 * thinWidth / max(abs(sRate), 0.06), 260.0);

    /* ---- vertical, field-aligned rays: fine striations ----
       Two octaves at unrelated frequencies keep the shafts from
       settling into an obviously periodic comb. */
    vec3 rq = vec3(
      (xw + warpA * 26.0 + warpC * 14.0 + d.a * 9.0) * 0.026 + uTime * 0.010,
      v * 0.030 + fi * 0.37,
      uTime * 0.026 + fi * 6.13
    );
    vec4 r = texture(uNoise, rq);
    vec4 r2 = texture(uNoise, rq * vec3(2.17, 2.11, 1.0) + vec3(0.41, 0.13, 0.67));
    float rayN = r.g * 0.44 + r.b * 0.24 + r2.b * 0.20 + r2.g * 0.12;
    float shaft = smoothstep(0.34, 0.82, rayN);
    float clustering = smoothstep(0.22, 0.78, r2.r * 0.6 + r2.a * 0.4);
    float ray = clamp(shaft * (0.46 + 0.54 * clustering) + (r2.a - 0.5) * 0.10, 0.0, 1.0);
    ray = pow(ray, 1.12);

    /* ---- arc segments and large-scale activity lobes ---- */
    float arc = smoothstep(0.30, 0.80, d.r * 0.72 + (warpC * 0.5 + 0.5) * 0.28);
    float lobe = smoothstep(-0.30, 0.60, warpB * 0.80 + (d.b - 0.5) * 0.40);

    /* ---- arc-scale envelope: whole stretches fade to dark.
       Shifting the phase per sheet lets a background arc emerge
       through the gaps of the arc in front of it. ---- */
    float env = smoothstep(-0.15, 0.35, warpD + float(k) * 0.17);

    /* ---- altitude profile: each ray tops out at its own height ---- */
    /* The lower border of a real arc is a fairly straight, coherent
       line; only large-scale structure is allowed to move it, which
       stops the bright base from looking like a grass fringe. */
    float bottom = 0.042 + 0.008 * (d.b - 0.5) + 0.014 * warpD
                 + 0.012 * warpA
                 + 0.011 * sin(xw * 0.0026 + uTime * 0.07 + fi * 1.7);
    float top = 0.95 + 0.25 * (warpB * 0.5 + 0.5) + uSurge * 0.08;
    float bright = clamp(ray * 0.55 + r.a * 0.35 + d.b * 0.10, 0.0, 1.0);
    float hTop = min(top * mix(0.52, 1.02, bright) * (1.0 + 0.26 * fi), 1.78);
    float prof = smoothstep(bottom, bottom + 0.045, v);
    prof *= 1.0 - smoothstep(hTop * 0.55, hTop, v);
    prof *= mix(1.0, 0.62, smoothstep(bottom, hTop, v));

    float rayAmp = 0.35 + 1.45 * ray;
    float sheetGain = mix(1.0, 0.55, fi / 3.0) * mix(0.75, 1.05, d.b);

    float shape = prof * (0.10 + 0.90 * env);
    float dens = pathSheet * shape * (0.30 + 0.70 * arc)
               * (0.40 + 0.60 * lobe) * mix(1.0, rayAmp, smoothstep(bottom, bottom + 0.30, v));
    dens += pathThin * shape * mix(0.55, (0.20 + 1.30 * ray * ray), smoothstep(bottom, bottom + 0.34, v))
          * (0.25 + 0.75 * arc) * 0.36;

    /* Sharp green lower border: a signature of bright auroral arcs. */
    float e0 = (v - bottom - 0.095) / 0.105;
    float edge = exp(-e0 * e0);
    dens += pathSheet * prof * env * arc * lobe * edge * 0.52;

    dens *= sheetGain * detail;
    if (dens <= 0.02) continue;

    vec3 c = emissionColor(v, ray, uActivity, uColorBias);
    // Bright filaments desaturate slightly, as exposed film does.
    c = mix(c, vec3(0.80, 1.0, 0.92), ray * ray * 0.16);

    tHit[k] = t;
    hitCol[k] = c;
    hitDen[k] = dens;
  }

  /* ---- composite the layers front to back ---- */
  for (int i = 0; i < 4; i++) {
    for (int j = i + 1; j < 4; j++) {
      if (tHit[j] < tHit[i]) {
        float tt = tHit[i]; tHit[i] = tHit[j]; tHit[j] = tt;
        vec3 cc = hitCol[i]; hitCol[i] = hitCol[j]; hitCol[j] = cc;
        float dd = hitDen[i]; hitDen[i] = hitDen[j]; hitDen[j] = dd;
      }
    }
  }

  vec3 acc = vec3(0.0);
  float trans = 1.0;
  for (int i = 0; i < 4; i++) {
    if (hitDen[i] <= 0.0 || tHit[i] > tf) continue;
    float fog = exp(-tHit[i] * 0.00105);
    acc += trans * hitCol[i] * (hitDen[i] * gainBase * fog);
    trans *= exp(-hitDen[i] * absorb);
  }

  fragColor = vec4(acc, 1.0);
}`;
})();
