// Boot: read scan.json, pick the level for this device, load base.bin (draws right away), then
// stream fine.bin bricks for the level, sharpening the view as they arrive. Renders only when
// something changes, at reduced resolution while you interact and full resolution once still.
import { loadManifest, loadBase, streamFine } from "./loader.js";
import { createRenderer } from "./renderer.js";
import { createView } from "./view.js";
import { createUI, MODE } from "./ui.js";

const $ = (id) => document.getElementById(id);
const BG = [0.043, 0.051, 0.063];
// Opacity is defined per ALPHA_MM of ray so every level looks equally dense.
const ALPHA_MM = 0.6;
// Source commit + commit time (Pacific), stamped in by web/publish.sh. "dev" = working copy.
const BUILD = "9a9cfae · 2026-11-07 13:28 PST".startsWith("__") ? "dev build" : "9a9cfae · 2026-11-07 13:28 PST";

const state = { mode: MODE.BONE, axis: 0, slice: 0.5, cut: 0, lo: 350, hi: 2200, shade: 0.6, hiDpi: false, layers: new Set() };
let man = null, base = null, level = null, legend = [];
let win = [-500, 2500], ext = [1, 1, 1], voxelMM = 0.6;
let info = "", progress = "", loadGen = 0, abort = null;
const toStored = (g) => (g - win[0]) / (win[1] - win[0]);
const isMobile = () => /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)); // iPadOS reports as a Mac

function setStatus(msg, frac) {
  $("status").hidden = !msg;
  $("msg").textContent = msg || "";
  $("bar").hidden = frac == null;
  if (frac != null) $("bar").firstElementChild.style.width = (100 * frac).toFixed(1) + "%";
}
function fail(e) {
  if (e && e.name === "AbortError") return;
  console.error(e);
  setStatus("Couldn't load the scan:\n" + (e && e.message));
}

const canvas = $("gl");
let R;
try { R = createRenderer(canvas); } catch (e) { fail(e); }
let interactive = false, idleTimer = 0, pending = false, moveScale = 1, lastMoveDraw = 0;
function poke() {
  interactive = true;
  request();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { interactive = false; request(); }, 200);
}
function request() { if (!pending) { pending = true; requestAnimationFrame(frame); } }

const ui = createUI(state, {
  poke,
  onLayers() { if (R && legend.length) R.setLabels(legend, state.layers); poke(); },
  onAxis() { view.v.sliceZoom = 1; view.v.slicePan = [0, 0]; },
  onLevel(id) { if (id !== level) loadLevel(id).catch(fail); },
  onReset() { view.reset(); poke(); },
});
const view = createView(canvas, state, {
  poke, setSlice: ui.setSlice, panelHeight: () => $("panel").getBoundingClientRect().height,
});

function frame(now) {
  pending = false;
  if (!base) return;
  // Adapt the moving resolution to keep interaction responsive.
  if (interactive && lastMoveDraw) {
    const dt = now - lastMoveDraw;
    if (dt > 45) moveScale = Math.max(0.35, moveScale * 0.85);
    else if (dt < 22) moveScale = Math.min(1, moveScale * 1.05);
  }
  lastMoveDraw = interactive ? now : 0;
  const dpr = window.devicePixelRatio || 1;
  const scale = interactive ? Math.min(dpr, 1) * moveScale : (state.hiDpi ? dpr : Math.min(2, dpr));
  const w = Math.max(1, Math.floor(canvas.clientWidth * scale)), h = Math.max(1, Math.floor(canvas.clientHeight * scale));
  const p = view.params(w, h, ext, voxelMM, interactive);
  const lit = state.mode === MODE.MIP || state.mode === MODE.SLICE ? 0 : state.shade;
  R.draw(w, h, {
    ...p, lo: toStored(state.lo), hi: toStored(Math.max(state.hi, state.lo + 1)), shade: lit,
    mode: state.mode, axis: state.axis, slice: state.slice, alphaMM: ALPHA_MM, bg: BG,
  });
  $("stats").textContent = `${BUILD}\n${info}${progress ? " · " + progress : ""}\n${w}×${h} ${interactive ? "moving" : "still"}`;
}

function describe(t) {
  const lv = man.levels.find((l) => l.id === level);
  const gpu = (base.density.data.length * 2 + R.atlasBytes) / 1e6;
  info = `${lv.label} · ${(lv.bytes / 1e6).toFixed(1)} MB · ${gpu.toFixed(0)} MB GPU\n` +
    `0.6 mm + ${R.bricks} bricks @ 0.3 mm · ${t}`;
}

async function boot() {
  if (!R) { setStatus("WebGL2 isn't available in this browser."); return; }
  man = await loadManifest();
  win = man.window;
  legend = man.labels.legend;
  const sp = man.base.spacing_mm, d = man.base.dims;
  ext = [d[0] * sp[0], d[1] * sp[1], d[2] * sp[2]];
  view.v.half = [ext[0] / 2, ext[2] / 2, ext[1] / 2]; // model axes (i, k, -j)
  const def = (isMobile() ? man.defaults.mobile : man.defaults.desktop) || man.levels[0].id;
  level = new URLSearchParams(location.search).get("fidelity") || def;
  if (!man.levels.some((l) => l.id === level)) level = def;
  ui.setLevels(man.levels, def);
  ui.setLegend(legend);
  ui.markLevel(level);

  const t0 = performance.now();
  const b = await loadBase(man, undefined, (got, total) =>
    setStatus(`Downloading scan… ${(got / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`, got / total));
  R.setBase(b);
  base = b;
  view.reset();
  ui.applyPreset();
  setStatus("");
  describe(`base ${Math.round(performance.now() - t0)} ms`);
  poke();
  await loadLevel(level, true);
}

// Allocate the atlas for the level's bricks and stream them in. Switching level restarts this.
async function loadLevel(id, first = false) {
  const lv = man.levels.find((l) => l.id === id);
  if (!lv) return;
  if (abort) abort.abort();
  abort = new AbortController();
  const gen = ++loadGen;
  level = id;
  ui.markLevel(id);
  R.allocAtlas(lv.bricks);
  voxelMM = lv.bricks ? man.fine.spacing_mm[0] : man.base.spacing_mm[0];
  describe(first ? "" : "switching");
  poke();
  if (!lv.chunks) { progress = ""; describe("ready"); poke(); return; }
  const t0 = performance.now();
  await streamFine(man, lv.chunks, abort.signal, async (chunk) => {
    if (gen !== loadGen) return;
    R.addBricks(chunk);
    describe(`${Math.round(performance.now() - t0)} ms`);
    request();
  }, (got, total) => { if (gen === loadGen) progress = got < total ? `sharpening ${Math.round(100 * got / total)}%` : ""; });
  if (gen === loadGen) { progress = ""; describe(`fine ${Math.round(performance.now() - t0)} ms`); poke(); }
}

canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); base = null; setStatus("The graphics context was lost.\nReload the page to continue."); });
window.addEventListener("resize", () => poke());
ui.sync();
boot().catch(fail);
