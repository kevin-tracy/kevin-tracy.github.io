// WebGL2 side: textures, the fine-brick atlas and page table, uniforms, draw.
import { VS, FS } from "./shaders.js";

const E = 18; // fine brick edge incl. 1-voxel apron (preprocess/fidelity.py FB + 2 * APRON)
const UNIFORMS = ["uVol", "uLab", "uPage", "uBMask", "uAtlas", "uInvMVP", "uBoxHalf", "uFwd", "uTf", "uMisc",
  "uDims", "uSlice", "uBg", "uAtlasInv", "uLabCol", "uVis", "uSolid", "uSolidCol"];

export function createRenderer(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: "high-performance" });
  if (!gl) return null;
  const U = {};
  let tex = {}, page = null, pageDims = [1, 1, 1], atlas = null, slots = 0, used = 0;
  let baseDims = [1, 1, 1];

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  for (const n of UNIFORMS) U[n] = gl.getUniformLocation(prog, n);
  ["uVol", "uLab", "uPage", "uBMask", "uAtlas"].forEach((n, i) => gl.uniform1i(U[n], i));
  gl.bindVertexArray(gl.createVertexArray());
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  function make3D(unit, [w, h, d], data, { internal = gl.R8, format = gl.RED, filter = gl.NEAREST } = {}) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texImage3D(gl.TEXTURE_3D, 0, internal, w, h, d, 0, format, gl.UNSIGNED_BYTE, data);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, filter);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    return t;
  }
  const drop = (t) => t && gl.deleteTexture(t);

  // Base layers: density, labels, page table (slots empty, a = coarse brick max), label bits.
  function setBase(base) {
    for (const t of Object.values(tex)) drop(t);
    baseDims = base.density.dims;
    pageDims = base.occ.dims;
    page = new Uint8Array(pageDims[0] * pageDims[1] * pageDims[2] * 4);
    for (let i = 0; i < base.occ.data.length; i++) page[i * 4 + 3] = base.occ.data[i];
    tex = {
      vol: make3D(0, baseDims, base.density.data, { filter: gl.LINEAR }),
      lab: make3D(1, baseDims, base.labels.data, { internal: gl.R8UI, format: gl.RED_INTEGER }),
      page: make3D(2, pageDims, page, { internal: gl.RGBA8UI, format: gl.RGBA_INTEGER }),
      bmask: make3D(3, base.lmask.dims, base.lmask.data, { internal: gl.R8UI, format: gl.RED_INTEGER }),
    };
    allocAtlas(0);
  }
  function basePage() { // forget fine bricks (level switch)
    for (let i = 0; i < page.length; i += 4) page[i] = page[i + 1] = page[i + 2] = 0;
  }

  // One 3D texture holding `n` bricks of E^3 voxels, laid out as a near-cubic grid of slots.
  let grid = [1, 1, 1];
  function allocAtlas(n) {
    drop(atlas);
    if (page) basePage();
    const maxTex = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE), cap = Math.floor(maxTex / E);
    const sx = Math.min(cap, Math.max(1, Math.ceil(Math.cbrt(n)))), sy = Math.min(cap, Math.max(1, Math.ceil(Math.sqrt(n / sx))));
    const sz = Math.max(1, Math.ceil(n / (sx * sy)));
    if (sz > cap) throw new Error(`too many bricks for this GPU (${n})`);
    grid = n ? [sx, sy, sz] : [1, 1, 1];
    slots = n ? sx * sy * sz : 0;
    used = 0;
    atlas = make3D(4, n ? grid.map((s) => s * E) : [1, 1, 1], null, { filter: gl.LINEAR });
    if (page) uploadPage();
  }
  function uploadPage() {
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, tex.page);
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, ...pageDims, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, page);
  }
  // A decoded fine.bin chunk: copy each brick into the next free slot and point its page at it.
  function addBricks({ count, head, vox }) {
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_3D, atlas);
    const n3 = E * E * E;
    for (let i = 0; i < count && used < slots; i++, used++) {
      const sx = used % grid[0], sy = Math.floor(used / grid[0]) % grid[1], sz = Math.floor(used / (grid[0] * grid[1]));
      gl.texSubImage3D(gl.TEXTURE_3D, 0, sx * E, sy * E, sz * E, E, E, E, gl.RED, gl.UNSIGNED_BYTE, vox, i * n3);
      const [bx, by, bz, mx] = head.subarray(i * 4, i * 4 + 4);
      const k = ((bz * pageDims[1] + by) * pageDims[0] + bx) * 4;
      page[k] = sx + 1; page[k + 1] = sy + 1; page[k + 2] = sz + 1;
      if (mx > page[k + 3]) page[k + 3] = mx;
    }
    uploadPage();
  }

  // Label legend -> colours, visible bits, the solid label (nerve canal).
  function setLabels(legend, visible) {
    const col = new Float32Array(24).fill(0.9);
    let vis = 1, solid = 0, solidCol = [1, 0.8, 0.3, 0.5];
    for (const l of legend) {
      col.set(l.color, l.id * 3);
      if (l.id === 6) col.set(l.color, 0); // unlabelled voxels at a bone surface look like other bone
      if (!visible.has(l.id)) continue;
      if (l.solid) { solid |= 1 << l.id; solidCol = [...l.color, l.solid]; } else vis |= 1 << l.id;
    }
    gl.uniform3fv(U.uLabCol, col);
    gl.uniform1i(U.uVis, vis);
    gl.uniform1i(U.uSolid, solid);
    gl.uniform4f(U.uSolidCol, ...solidCol);
  }

  function draw(w, h, p) {
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.uniformMatrix4fv(U.uInvMVP, false, p.invMVP);
    gl.uniform4f(U.uBoxHalf, ...p.half, p.step);
    gl.uniform4f(U.uFwd, ...p.fwd, p.cut);
    gl.uniform4f(U.uTf, p.lo, p.hi, 1, p.shade);
    gl.uniform4f(U.uMisc, p.mode, p.axis, p.slice, p.alphaMM);
    gl.uniform4f(U.uDims, ...baseDims, 8);
    gl.uniform4f(U.uSlice, ...p.sliceXform);
    gl.uniform3f(U.uBg, ...p.bg);
    gl.uniform3f(U.uAtlasInv, ...grid.map((s) => 1 / Math.max(s * E, 1)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    gl, setBase, allocAtlas, addBricks, setLabels, draw,
    get bricks() { return used; },
    get atlasBytes() { return slots * E * E * E; },
  };
}
