// GLSL for the Earth, its atmosphere, stars, points (people, echoes, gazes, lanterns) and arcs.

export const earthVert = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vPos;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPos = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export const earthFrag = /* glsl */ `
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform sampler2D uWater;
uniform sampler2D uClouds;
uniform vec3 uSun;
uniform float uTime;
uniform float uReveal;
uniform vec3 uRipO[6];
uniform float uRipT[6];
varying vec2 vUv;
varying vec3 vN;
varying vec3 vPos;

void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vPos);
  float ndl = dot(N, uSun);
  float dayAmt = smoothstep(-0.10, 0.24, ndl);
  float diff = max(ndl, 0.0);

  vec3 day = texture2D(uDay, vUv).rgb;
  float water = texture2D(uWater, vUv).r;

  // Grade: deepen the oceans, keep land slightly muted so people stay the brightest things.
  float lum = dot(day, vec3(0.299, 0.587, 0.114));
  day = mix(vec3(lum), day, 0.92);
  day = mix(day, day * vec3(0.55, 0.78, 1.18), water * 0.65);

  vec3 lit = day * (0.035 + 0.92 * pow(diff, 0.85));

  // Sun glint on water (hidden under cloud).
  vec4 ct0 = texture2D(uClouds, vec2(vUv.x + uTime * 0.0009, vUv.y));
  float c0 = ct0.r * ct0.a;
  vec3 H = normalize(uSun + V);
  float spec = pow(max(dot(N, H), 0.0), 1400.0) * water * (1.0 - c0);
  lit += vec3(1.0, 0.86, 0.66) * spec * 0.16 * dayAmt;
  float sheen = pow(max(dot(N, H), 0.0), 9.0) * water;
  lit += vec3(0.30, 0.42, 0.60) * sheen * 0.02 * dayAmt;

  // Clouds drift slowly eastward; a second offset sample fakes their shadow.
  vec2 cuv = vec2(vUv.x + uTime * 0.0009, vUv.y);
  vec4 ct = texture2D(uClouds, cuv);
  float c = ct.r * ct.a;
  vec4 cs = texture2D(uClouds, cuv + vec2(0.004, 0.002));
  float shadow = cs.r * cs.a;
  lit *= 1.0 - shadow * 0.32;
  lit = mix(lit, vec3(0.92, 0.95, 1.0) * (0.03 + 0.80 * pow(diff, 0.9)), c * 0.82);

  // Night side: city lights, dimmed under cloud, over a faint moonlit surface.
  vec3 nt = texture2D(uNight, vUv).rgb;
  float nl = max(max(nt.r, nt.g), nt.b);
  vec3 city = vec3(1.0, 0.72, 0.42) * pow(nl, 1.25) * 3.4;
  city += vec3(1.0, 0.92, 0.80) * pow(nl, 3.0) * 2.4;
  vec3 night = day * vec3(0.030, 0.046, 0.085) + city * (1.0 - c * 0.75);
  night += vec3(0.05, 0.07, 0.11) * c * 0.22;

  vec3 col = mix(night, lit, dayAmt);

  // Warm scatter along the terminator.
  float term = exp(-pow((ndl - 0.03) / 0.11, 2.0));
  col += vec3(1.0, 0.42, 0.16) * term * 0.055 * (0.35 + lum + c);

  // Limb haze.
  float fr = pow(1.0 - max(dot(N, V), 0.0), 3.2);
  float sunSide = smoothstep(-0.35, 0.45, ndl);
  vec3 haze = mix(vec3(0.07, 0.11, 0.25), vec3(0.30, 0.56, 1.0), sunSide);
  haze = mix(haze, vec3(1.0, 0.50, 0.24), term * 0.55);
  col += haze * fr * (0.22 + 0.78 * sunSide) * 0.85;

  // Ripples: a ring of light travelling outward over the surface from someone's light,
  // all the way round to the far side of the planet.
  for (int i = 0; i < 6; i++) {
    float age = uRipT[i];
    if (age < 0.0) continue;
    float ang = acos(clamp(dot(N, uRipO[i]), -1.0, 1.0));
    float r = age * 0.62;
    float life = clamp(1.0 - age / 5.2, 0.0, 1.0);
    float lead = exp(-pow((ang - r) / 0.011, 2.0));
    float wake = exp(-pow((ang - r + 0.05) / 0.045, 2.0)) * 0.16 * step(ang, r);
    float echo = exp(-pow((ang - r * 0.74) / 0.008, 2.0)) * 0.32;
    col += vec3(1.0, 0.72, 0.40) * (lead + wake + echo) * life * 0.85;
  }

  col *= uReveal;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export const atmoVert = /* glsl */ `
varying vec3 vPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export const atmoFrag = /* glsl */ `
uniform vec3 uSun;
uniform float uReveal;
varying vec3 vPos;
void main() {
  vec3 ray = normalize(vPos - cameraPosition);
  float t = -dot(cameraPosition, ray);
  vec3 closest = cameraPosition + ray * t;
  float d = length(closest);
  if (d < 0.985) discard;
  float h = max(d - 1.0, 0.0);
  float glow = (exp(-h * 30.0) * 0.80 + exp(-h * 9.0) * 0.13) * smoothstep(1.30, 1.08, d);
  vec3 n = normalize(closest);
  float ndl = dot(n, uSun);
  float sunSide = smoothstep(-0.42, 0.42, ndl);
  float term = exp(-pow((ndl + 0.02) / 0.20, 2.0));
  vec3 col = mix(vec3(0.05, 0.08, 0.20), vec3(0.26, 0.52, 1.0), sunSide);
  col = mix(col, vec3(1.0, 0.48, 0.22), term * 0.50);
  float a = glow * (0.10 + 0.90 * sunSide);
  gl_FragColor = vec4(col * a * uReveal, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export const starVert = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute vec3 aColor;
uniform float uTime;
uniform float uPx;
varying vec3 vColor;
varying float vTw;
void main() {
  vColor = aColor;
  vTw = 0.78 + 0.22 * sin(uTime * (0.6 + aPhase * 1.7) + aPhase * 40.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPx;
}`;

export const starFrag = /* glsl */ `
varying vec3 vColor;
varying float vTw;
uniform float uReveal;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = dot(p, p);
  float a = exp(-d * 5.5);
  gl_FragColor = vec4(vColor * a * vTw * uReveal, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// One point cloud draws everything that sits on the globe.
// aKind: 0 live person, 1 self, 2 echo, 3 gaze, 4 lantern, 5 lantern (mine), 6 comet head
export const dotVert = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute float aKind;
attribute float aGlow;
uniform float uTime;
uniform float uPx;
uniform float uDist;
varying float vKind;
varying float vGlow;
varying float vPulse;
varying float vFacing;
void main() {
  vKind = aKind;
  vGlow = aGlow;
  vec3 pos = position;
  float pulse = 1.0;
  if (aKind < 1.5) {
    pulse = 1.0 + 0.16 * sin(uTime * 1.9 + aPhase * 6.283);
  } else if (aKind > 3.5 && aKind < 5.5) {
    pos *= 1.0 + 0.0035 * sin(uTime * 0.7 + aPhase * 6.283);
    pulse = 1.0 + 0.08 * sin(uTime * 2.6 + aPhase * 17.0) + 0.05 * sin(uTime * 7.1 + aPhase * 5.0);
  } else if (aKind > 2.5 && aKind < 3.5) {
    pulse = 1.0 + 0.10 * sin(uTime * 1.1 + aPhase * 6.283);
  }
  vPulse = pulse;
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vec3 toCam = normalize(cameraPosition - wp.xyz);
  vFacing = smoothstep(-0.05, 0.22, dot(normalize(wp.xyz), toCam));
  vec4 mv = viewMatrix * wp;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(aSize * pulse * uPx * (uDist / max(-mv.z, 0.1)), 132.0 * uPx);
}`;

export const dotFrag = /* glsl */ `
uniform float uReveal;
varying float vKind;
varying float vGlow;
varying float vPulse;
varying float vFacing;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  vec3 col = vec3(0.0);

  if (vKind < 0.5) {
    // A person: hot white core, amber bloom.
    float core = exp(-d * d * 60.0);
    float halo = exp(-d * 5.0) * 0.55;
    col = vec3(1.0, 0.93, 0.80) * core * 3.2 + vec3(1.0, 0.66, 0.30) * halo;
  } else if (vKind < 1.5) {
    // You: same light, plus a thin ring so you can find yourself.
    float core = exp(-d * d * 60.0);
    float halo = exp(-d * 4.6) * 0.65;
    float ring = exp(-pow((d - 0.56) / 0.035, 2.0)) * 0.55;
    col = vec3(1.0, 0.96, 0.86) * core * 3.6 + vec3(1.0, 0.70, 0.34) * (halo + ring);
  } else if (vKind < 2.5) {
    // An echo: someone who was here recently. Cool and quiet.
    float core = exp(-d * d * 30.0);
    float ring = exp(-pow((d - 0.52) / 0.07, 2.0)) * 0.22;
    col = vec3(0.50, 0.66, 1.0) * (core * (0.85 + 0.8 * vGlow) + ring * (0.5 + 0.5 * vGlow));
  } else if (vKind < 3.5) {
    // Where someone else is looking.
    float disc = smoothstep(1.0, 0.0, d);
    float ring = exp(-pow((d - 0.72) / 0.10, 2.0));
    col = mix(vec3(0.55, 0.80, 1.0), vec3(1.0, 0.78, 0.50), step(1.5, vGlow)) * (disc * disc * 0.05 + ring * 0.07) * vGlow;
  } else if (vKind < 5.5) {
    // A lantern: a paper body, dark caps top and bottom, a flame glowing through.
    vec2 q = p - vec2(0.0, -0.02);
    float body = sdRoundBox(q, vec2(0.25, 0.35), 0.13);
    float inside = smoothstep(0.025, -0.025, body);
    vec2 f = (q - vec2(0.0, 0.10)) * vec2(3.0, 2.3);
    float flame = exp(-dot(f, f));
    vec3 paper = mix(vec3(0.80, 0.20, 0.04), vec3(1.0, 0.62, 0.22), flame);
    if (vKind > 4.5) paper = mix(paper, vec3(1.0, 0.90, 0.66), 0.35);
    float cap = smoothstep(0.255, 0.30, abs(q.y));
    float ribs = 0.90 + 0.10 * cos(q.y * 42.0);
    float halo = exp(-d * 3.4) * (0.22 + 0.5 * vGlow);
    col = paper * inside * ribs * (1.0 - 0.80 * cap) * (0.62 + 0.45 * vGlow)
        + vec3(1.0, 0.95, 0.80) * inside * exp(-dot(f, f) * 6.0) * 0.35
        + vec3(1.0, 0.50, 0.16) * halo;
    col *= 0.94 + 0.6 * (vPulse - 1.0);
  } else {
    // Comet head of a travelling wave.
    float core = exp(-d * d * 40.0);
    float halo = exp(-d * 4.0) * 0.6;
    col = vec3(1.0, 0.95, 0.85) * core * 4.0 + vec3(1.0, 0.72, 0.40) * halo;
  }

  col *= smoothstep(1.0, 0.70, d) * vFacing * uReveal;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export const arcVert = /* glsl */ `
varying vec2 vUv;
varying float vFacing;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 toCam = normalize(cameraPosition - wp.xyz);
  vFacing = smoothstep(-0.25, 0.15, dot(normalize(wp.xyz), toCam));
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export const arcFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uHead;     // 0..1 position of the travelling head (>1.2 = none)
uniform float uTail;     // tail length in uv
uniform float uBase;     // persistent brightness of the drawn part
uniform float uDrawn;    // how much of the arc exists (0..1)
uniform float uFade;     // overall opacity
uniform float uShimmer;  // 0..1 position of a slow shimmer on a resting thread
varying vec2 vUv;
varying float vFacing;
void main() {
  float u = vUv.x;
  float exists = step(u, uDrawn);
  float head = smoothstep(uHead - uTail, uHead, u) * step(u, uHead);
  head = head * head;
  float shimmer = exp(-pow((u - uShimmer) / 0.06, 2.0)) * 0.9;
  float ends = smoothstep(0.0, 0.03, u) * smoothstep(1.0, 0.97, u);
  float i = (uBase + shimmer * uBase * 2.2) * exists * ends + head * 2.6;
  vec3 col = uColor * i * uFade * (0.25 + 0.75 * vFacing);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export const ringFrag = /* glsl */ `
uniform float uLit;
uniform float uFlash;
uniform float uReveal;
varying vec2 vUv;
varying float vFacing;
void main() {
  float ends = smoothstep(0.0, 0.04, vUv.x) * smoothstep(1.0, 0.96, vUv.x);
  vec3 off = vec3(0.50, 0.62, 0.90) * 0.17;
  vec3 on = vec3(1.0, 0.70, 0.34) * (0.80 + uFlash * 3.0);
  vec3 col = mix(off, on, uLit) * ends * (0.35 + 0.65 * vFacing) * uReveal;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
