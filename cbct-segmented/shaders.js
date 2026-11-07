// Ray-marching shaders. One full-screen triangle; every pixel marches a ray through the volume.
//
// Data (all precomputed by preprocess/fidelity.py, see mds/next-directions.md):
//   uVol    0.6 mm density for the whole box (R8, linear)
//   uLab    0.6 mm anatomy labels (R8UI, nearest)
//   uPage   per 8^3-voxel brick: rgb = atlas slot + 1 (0 = no fine data), a = max density
//   uBMask  per brick: one bit per label present (for skipping hidden anatomy)
//   uAtlas  0.3 mm bricks (16^3 + 1-voxel apron) packed into one 3D texture (R8, linear)
// Where a brick has a fine copy the shader samples it, otherwise the coarse volume.

export const VS = `#version 300 es
out vec2 vNdc;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vNdc = p * 2.0 - 1.0;
  gl_Position = vec4(vNdc, 0.0, 1.0);
}`;

export const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
precision highp usampler3D;
in vec2 vNdc;
out vec4 outColor;
uniform sampler3D uVol;
uniform usampler3D uLab;
uniform usampler3D uPage;
uniform usampler3D uBMask;
uniform sampler3D uAtlas;
uniform mat4 uInvMVP;     // clip -> model space (mm, box centred at origin)
uniform vec4 uBoxHalf;    // xyz half extents, w ray step (mm)
uniform vec4 uFwd;        // xyz view dir in model space, w cut offset (mm)
uniform vec4 uTf;         // lo, hi (stored 0..1), opacity scale, shading
uniform vec4 uMisc;       // mode, slice axis, slice pos, reference step (mm)
uniform vec4 uDims;       // base voxel dims, brick size (base voxels)
uniform vec4 uSlice;      // ndc->plane scale xy, pan zw
uniform vec3 uBg;
uniform vec3 uAtlasInv;   // 1 / atlas size in voxels
uniform vec3 uLabCol[8];  // colour per label
uniform int uVis;         // bit per visible label (bit 0 = air, always set)
uniform int uSolid;       // bit per visible "solid" label (drawn from the label, not density)
uniform vec4 uSolidCol;   // rgb, opacity per reference step

const float E = 18.0;     // fine brick edge incl. apron

// Model space is (i, k, -j): x = patient left/right, y = superior, z = anterior.
vec3 toTex(vec3 p, vec3 h) { vec3 n = p / (2.0 * h) + 0.5; return vec3(n.x, 1.0 - n.z, n.y); }
vec3 toTexDir(vec3 d, vec3 h) { vec3 n = d / (2.0 * h); return vec3(n.x, -n.z, n.y); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

ivec3 brickOf(vec3 bv) { return clamp(ivec3(floor(bv / uDims.w)), ivec3(0), textureSize(uPage, 0) - 1); }
vec3 fineLoc(vec3 bv, ivec3 b) { return bv * 2.0 - vec3(b) * (2.0 * uDims.w) + 1.0; }
float fineAt(vec3 s0, vec3 loc) { return texture(uAtlas, (s0 + clamp(loc, vec3(0.5), vec3(E - 0.5))) * uAtlasInv).r; }

float dens(vec3 tc, vec3 bv, uvec4 pg, ivec3 b) {
  if (pg.r == 0u) return texture(uVol, tc).r;
  return fineAt((vec3(pg.rgb) - 1.0) * E, fineLoc(bv, b));
}
vec3 gradTex(vec3 tc, vec3 bv, uvec4 pg, ivec3 b) {
  if (pg.r == 0u) {
    vec3 o = 1.0 / uDims.xyz;
    return vec3(
      texture(uVol, tc + vec3(o.x, 0, 0)).r - texture(uVol, tc - vec3(o.x, 0, 0)).r,
      texture(uVol, tc + vec3(0, o.y, 0)).r - texture(uVol, tc - vec3(0, o.y, 0)).r,
      texture(uVol, tc + vec3(0, 0, o.z)).r - texture(uVol, tc - vec3(0, 0, o.z)).r);
  }
  vec3 s0 = (vec3(pg.rgb) - 1.0) * E, l = fineLoc(bv, b);
  return vec3(
    fineAt(s0, l + vec3(1, 0, 0)) - fineAt(s0, l - vec3(1, 0, 0)),
    fineAt(s0, l + vec3(0, 1, 0)) - fineAt(s0, l - vec3(0, 1, 0)),
    fineAt(s0, l + vec3(0, 0, 1)) - fineAt(s0, l - vec3(0, 0, 1)));
}
uint labelAt(vec3 bv) { return texelFetch(uLab, clamp(ivec3(bv), ivec3(0), ivec3(uDims.xyz) - 1), 0).r; }
bool bit(int m, uint l) { return ((m >> int(l)) & 1) != 0; }

// Smooth label membership from the 8 nearest label voxels (trilinear weights), so surfaces cut
// by a hidden label, and solid labels such as the nerve canal, are smooth instead of blocky.
// Returns visible weight + its gradient, solid weight + its gradient, and the dominant visible label.
struct Memb { float w; vec3 gw; float m; vec3 gm; uint lab; };
Memb membership(vec3 bv) {
  vec3 p = bv - 0.5, i0 = floor(p), f = p - i0;
  ivec3 mx = ivec3(uDims.xyz) - 1;
  Memb r = Memb(0.0, vec3(0.0), 0.0, vec3(0.0), 0u);
  float best = -1.0;
  for (int k = 0; k < 8; ++k) {
    ivec3 o = ivec3(k & 1, (k >> 1) & 1, k >> 2);
    uint l = texelFetch(uLab, clamp(ivec3(i0) + o, ivec3(0), mx), 0).r;
    vec3 fo = vec3(o);
    vec3 wv = mix(1.0 - f, f, fo);               // per-axis weights
    float wt = wv.x * wv.y * wv.z;
    vec3 sg = mix(vec3(-1.0), vec3(1.0), fo);    // d(weight)/df sign per axis
    vec3 dw = sg * vec3(wv.y * wv.z, wv.x * wv.z, wv.x * wv.y);
    if (bit(uSolid, l)) { r.m += wt; r.gm += dw; }
    else if (bit(uVis, l)) {
      r.w += wt; r.gw += dw;
      if (l != 0u && wt > best) { best = wt; r.lab = l; }
    }
  }
  return r;
}

vec3 shade(vec3 c, vec3 gTex, vec3 L, float amount) {
  vec3 gm = vec3(gTex.x, gTex.z, -gTex.y);
  float gl = length(gm);
  if (gl < 1e-5 || amount <= 0.0) return c;
  vec3 n = -gm / gl;
  float diff = abs(dot(n, L));
  float lit = 0.25 + 0.75 * diff + 0.3 * pow(diff, 32.0);
  return mix(c, c * lit, amount);
}

void main() {
  int mode = int(uMisc.x);
  float lo = uTf.x, hi = uTf.y;
  float invRange = 1.0 / max(hi - lo, 1e-4);

  if (mode == 3) {
    vec2 q = vNdc * uSlice.xy + uSlice.zw + 0.5;
    if (any(lessThan(q, vec2(0.0))) || any(greaterThan(q, vec2(1.0)))) { outColor = vec4(uBg, 1.0); return; }
    int axis = int(uMisc.y);
    float s = uMisc.z;
    vec3 tc;
    if (axis == 0)      tc = vec3(q.x, 1.0 - q.y, s);
    else if (axis == 1) tc = vec3(q.x, s, q.y);
    else                tc = vec3(s, q.x, q.y);
    vec3 bv = tc * uDims.xyz;
    ivec3 b = brickOf(bv);
    float g = clamp((dens(tc, bv, texelFetch(uPage, b, 0), b) - lo) * invRange, 0.0, 1.0);
    outColor = vec4(g, g, g, 1.0);
    return;
  }

  vec4 pn = uInvMVP * vec4(vNdc, 0.0, 1.0); pn /= pn.w;
  vec4 pf = uInvMVP * vec4(vNdc, 1.0, 1.0); pf /= pf.w;
  vec3 ro = pn.xyz;
  vec3 rd = normalize(pf.xyz - pn.xyz);
  vec3 h = uBoxHalf.xyz;

  vec3 rdSafe = mix(rd, vec3(1e-6), lessThan(abs(rd), vec3(1e-6)));
  vec3 ta = (-h - ro) / rdSafe, tb = (h - ro) / rdSafe;
  vec3 tmin = min(ta, tb), tmax = max(ta, tb);
  float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  float tf = min(min(tmax.x, tmax.y), tmax.z);
  float fd = dot(rd, uFwd.xyz);
  if (fd > 1e-4) tn = max(tn, (uFwd.w - dot(ro, uFwd.xyz)) / fd);
  if (tn >= tf) { outColor = vec4(uBg, 1.0); return; }

  float stepMM = uBoxHalf.w;
  float alphaExp = stepMM / uMisc.w;
  vec3 dtc = toTexDir(rd, h);
  vec3 brickTex = uDims.w / uDims.xyz;
  vec3 L = -rd;
  uint vis = uint(uVis), solid = uint(uSolid), hidden = ~(vis | solid) & 0xFEu;

  float t = tn + stepMM * hash12(gl_FragCoord.xy);
  vec4 acc = vec4(0.0);
  float mx = 0.0;

  for (int iter = 0; iter < 2048; ++iter) {
    if (t >= tf) break;
    vec3 tc = toTex(ro + rd * t, h);
    vec3 bv = tc * uDims.xyz;
    ivec3 b = brickOf(bv);
    uvec4 pg = texelFetch(uPage, b, 0);
    uint lm = texelFetch(uBMask, b, 0).r;
    bool hasSolid = (lm & solid) != 0u;
    float bmax = float(pg.a) / 255.0;
    float thr = (mode == 2) ? max(mx, lo) : lo;
    if (!hasSolid && ((lm & vis) == 0u || bmax <= thr)) {
      vec3 bmin = vec3(b) * brickTex;
      vec3 bnd = mix(bmin, bmin + brickTex, greaterThan(dtc, vec3(0.0)));
      vec3 tt = mix(vec3(1e9), (bnd - tc) / dtc, greaterThan(abs(dtc), vec3(1e-9)));
      float texit = min(min(tt.x, tt.y), tt.z);
      t += max(ceil(texit / stepMM), 1.0) * stepMM;
      continue;
    }
    // Mixed bricks (a hidden or solid label next to visible ones) need smooth membership.
    bool mixed = hasSolid || (lm & hidden) != 0u;
    Memb mb;
    if (mixed) mb = membership(bv);
    else { uint l = labelAt(bv); mb = Memb(1.0, vec3(0.0), 0.0, vec3(0.0), l); }

    if (mode == 2) {
      if (mb.w > 0.5) {
        mx = max(mx, dens(tc, bv, pg, b));
        if (mx >= hi) break;
      }
    } else {
      if (mb.m > 0.02) {
        float a = uSolidCol.a * smoothstep(0.3, 0.7, mb.m);
        a = 1.0 - pow(1.0 - min(a, 0.995), alphaExp);
        vec3 c = shade(uSolidCol.rgb, mb.gm, L, 0.8);
        acc.rgb += (1.0 - acc.a) * a * c;
        acc.a += (1.0 - acc.a) * a;
      }
      if (mb.w > 0.02) {
        float v = dens(tc, bv, pg, b);
        float x = (v - lo) * invRange;
        if (x > 0.0) {
          float cut = mixed ? smoothstep(0.3, 0.7, mb.w) : 1.0;
          float a = clamp(x, 0.0, 1.0) * uTf.z * cut;
          a = 1.0 - pow(1.0 - min(a, 0.995), alphaExp);
          vec3 lc = uLabCol[mb.lab];
          vec3 c = mix(lc * vec3(0.80, 0.63, 0.50), lc, clamp(x, 0.0, 1.0)); // warm tan -> label colour
          if (uTf.w > 0.0 && a > 0.002) {
            vec3 g = gradTex(tc, bv, pg, b);
            // On a surface cut open by hiding a label, light the cut, not the density.
            if (mixed && mb.w < 0.97) g = mix(g, mb.gw * 0.25, 1.0 - smoothstep(0.3, 0.9, mb.w));
            c = shade(c, g, L, uTf.w);
          }
          acc.rgb += (1.0 - acc.a) * a * c;
          acc.a += (1.0 - acc.a) * a;
        }
      }
      if (acc.a > 0.97) break;
    }
    t += stepMM;
  }

  if (mode == 2) {
    float g = clamp((mx - lo) * invRange, 0.0, 1.0);
    outColor = vec4(max(uBg, vec3(g)), 1.0);
    return;
  }
  outColor = vec4(acc.rgb + (1.0 - acc.a) * uBg, 1.0);
}`;
