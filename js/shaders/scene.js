/* ------------------------------------------------------------------
   Final scene pass: night sky, stars, Milky Way, upscaled aurora,
   bloom, procedural mountain silhouettes and filmic grading.
   ------------------------------------------------------------------ */
(function () {
  "use strict";
  const Aurora = (window.Aurora = window.Aurora || {});
  const S = (Aurora.Shaders = Aurora.Shaders || {});

  S.scene = `
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uAurora;
uniform sampler2D uBloomA;
uniform sampler2D uBloomB;
uniform sampler3D uNoise;
uniform vec2 uResolution;
uniform vec3 uCamPos;
uniform vec3 uFwd;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uTanHalf;
uniform float uAspect;
uniform float uTime;
uniform float uExposure;
uniform float uActivity;
uniform float uBloomStrength;
uniform float uBloomWide;

const float TAU = 6.28318530718;
const vec3 MW_AXIS = vec3(0.2626, 0.4021, 0.8774);

vec4 hash43(vec3 p) {
  vec4 p4 = fract(vec4(p.xyzx) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

vec3 starLayer(vec3 rd, float scale, float threshold, float radius, float seed, float gain) {
  vec3 q = rd * scale;
  vec3 cell = floor(q);
  vec3 f = q - cell;
  vec4 h = hash43(cell + seed);
  if (h.x < threshold) return vec3(0.0);

  vec3 sp = vec3(0.3) + h.yzw * 0.4;
  float d = length(f - sp);
  float core = smoothstep(radius, 0.0, d);
  float halo = exp(-d * d * 220.0);
  float mag = pow(h.z, 2.6) * 1.05 + 0.09;
  float twinkle = 0.86 + 0.14 * sin(uTime * (0.6 + h.w * 2.1) + h.y * 43.0);
  vec3 tint = mix(vec3(0.62, 0.76, 1.0), vec3(1.0, 0.87, 0.72), h.y);
  return tint * (core + halo * 0.45) * mag * gain * twinkle;
}

/* One-dimensional ridged noise in azimuth.  Integer frequencies keep
   the silhouette seamless across the 360° wrap. */
float ridge(float u, float baseFreq, float seed, float sharp) {
  float sum = 0.0;
  float amp = 0.55;
  float norm = 0.0;
  float f = baseFreq;
  for (int i = 0; i < 4; i++) {
    float n = texture(uNoise, vec3(u * f + seed, 0.37 + float(i) * 0.13, 0.73)).r;
    n = 1.0 - abs(n * 2.0 - 1.0);
    sum += amp * pow(max(n, 0.0), sharp);
    norm += amp;
    amp *= 0.48;
    f *= 2.0;
  }
  return clamp(sum / norm, 0.0, 1.0);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uFwd + uRight * (ndc.x * uTanHalf * uAspect) + uUp * (ndc.y * uTanHalf));
  float elev = asin(clamp(rd.y, -1.0, 1.0));

  /* ---------------- sky ---------------- */
  float upness = smoothstep(-0.015, 0.62, elev);
  vec3 col = mix(vec3(0.0105, 0.0170, 0.0260), vec3(0.0022, 0.0042, 0.0095), upness);

  /* faint airglow / atmospheric scatter above the northern horizon */
  float horizonGlow = exp(-abs(elev) * 16.0);
  col += vec3(0.010, 0.020, 0.018) * horizonGlow * 0.8;

  /* ---------------- Milky Way ---------------- */
  float mwBand = dot(rd, MW_AXIS);
  float mwMask = exp(-pow(mwBand * 2.55, 2.0));
  if (mwMask > 0.004) {
    float n1 = texture(uNoise, rd * 2.7 + vec3(0.31, 0.13, 0.77)).r;
    float n2 = texture(uNoise, rd * 5.6 + vec3(0.83, 0.42, 0.11)).g;
    float dust = smoothstep(0.30, 0.86, n1) * 0.72 + n2 * 0.28;
    vec3 mw = mwMask * (0.20 + 0.80 * dust) * vec3(0.017, 0.023, 0.040);
    mw *= 0.35 + 0.65 * smoothstep(0.0, 0.35, elev);
    col += mw;
  }

  /* ---------------- stars ---------------- */
  float starVis = smoothstep(-0.01, 0.10, elev) * (1.0 - horizonGlow * 0.45);
  if (starVis > 0.01) {
    vec3 stars = vec3(0.0);
    stars += starLayer(rd, 212.0, 0.9875, 0.235, 3.1, 1.0);
    stars += starLayer(rd, 465.0, 0.9945, 0.185, 71.7, 0.55);
    col += stars * starVis;
  }

  /* ---------------- aurora + bloom ---------------- */
  vec3 aurora = texture(uAurora, vUv).rgb;
  col += aurora;

  vec2 bloomUv = vUv;
  vec3 bloom = texture(uBloomA, bloomUv).rgb * uBloomStrength;
  bloom += texture(uBloomB, bloomUv).rgb * uBloomWide;
  col += bloom;

  /* ---------------- mountains ---------------- */
  float az = atan(rd.x, rd.z);
  float u = az / TAU + 0.5;

  float farH = 0.0035 + 0.190 * pow(ridge(u, 6.0, 0.23, 1.10), 1.10);
  float nearH = 0.0020 + 0.130 * pow(ridge(u, 9.0, 0.71, 1.75), 1.40);

  float aa = 0.00055;
  float mFar = smoothstep(farH + aa, farH - aa, elev);
  float mNear = smoothstep(nearH + aa, nearH - aa, elev);

  if (mFar > 0.001) {
    float depth = clamp((farH - elev) / max(farH, 0.001), 0.0, 1.0);
    float rim = smoothstep(farH - 0.010, farH, elev);
    vec3 c = mix(vec3(0.0060, 0.0105, 0.0160), vec3(0.0022, 0.0040, 0.0068), depth);
    c += vec3(0.0045, 0.0125, 0.0105) * rim * (0.25 + 0.55 * uActivity);
    c += vec3(0.0030, 0.0048, 0.0070) * (1.0 - depth) * 0.5;
    col = mix(col, c, mFar);
  }

  if (mNear > 0.001) {
    float facet = texture(uNoise, vec3(u * 16.0, elev * 26.0 + 0.4, 0.21)).r;
    float facet2 = texture(uNoise, vec3(u * 41.0, elev * 70.0 + 0.9, 0.57)).g;
    float shade = 0.72 + 0.28 * facet + 0.12 * facet2;
    vec3 c = vec3(0.0028, 0.0048, 0.0068) * shade;
    float rimN = smoothstep(nearH - 0.006, nearH, elev);
    c += vec3(0.0035, 0.0100, 0.0085) * rimN * (0.18 + 0.45 * uActivity);
    col = mix(col, c, mNear);
  }

  /* ground / frozen tundra below the horizon */
  float mGround = smoothstep(0.0012, -0.0012, elev);
  if (mGround > 0.001) {
    float snoise = texture(uNoise, vec3(u * 7.0, elev * 120.0 + 0.5, 0.33)).r;
    float snoise2 = texture(uNoise, vec3(u * 23.0, elev * 260.0 + 0.2, 0.81)).g;
    float snow = 0.55 + 0.45 * snoise * (0.6 + 0.4 * snoise2);
    vec3 g = vec3(0.0026, 0.0042, 0.0058) * (0.55 + 0.65 * snow);
    float lit = smoothstep(0.06, 0.0, elev) * (0.35 + 0.65 * snow);
    g += vec3(0.0055, 0.0170, 0.0125) * lit * (0.25 + 0.75 * uActivity) * 0.7;
    col = mix(col, g, mGround);
  }

  /* subtle horizon haze over the base of the terrain */
  col += vec3(0.006, 0.011, 0.011) * exp(-abs(elev) * 42.0) * 0.35;

  /* ---------------- grade / output ---------------- */
  col *= uExposure;
  col = acesTone(col);

  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, 1.12);
  col = max(col, 0.0);

  /* cool shadow lift, warm highlight restraint */
  col = mix(col, col * vec3(0.91, 1.00, 1.10), 0.30 * (1.0 - luma));

  col = linearToSrgb(col);

  vec2 vq = (vUv - 0.5) * vec2(1.0, 0.92);
  float vig = smoothstep(1.05, 0.28, length(vq));
  col *= mix(0.60, 1.0, vig);

  float grain = hash12(gl_FragCoord.xy + fract(uTime) * 517.0) - 0.5;
  col += grain * 0.010;
  col += (hash12(gl_FragCoord.xy + 7.13) - 0.5) / 255.0;

  fragColor = vec4(col, 1.0);
}`;
})();
