// The control panel: modes, slice axis, cut/slice sliders, anatomy layers, Adjust, settings.
const $ = (id) => document.getElementById(id);

export const MODE = { BONE: 0, TEETH: 1, MIP: 2, SLICE: 3 };
// Gray window (Hounsfield-like units), shading, and which anatomy labels each mode shows.
// Labels: 1 upper jaw, 2 lower jaw, 3 upper teeth, 4 lower teeth, 5 nerve canal, 6 other bone,
// 7 skin & soft tissue (see LABELS in preprocess/fidelity.py). Skin is off by default.
export const PRESETS = [
  { lo: 350, hi: 2200, shade: 0.6, layers: [1, 2, 3, 4, 5, 6] },  // bone
  { lo: 1200, hi: 2600, shade: 0.7, layers: [3, 4, 5] },           // teeth (whole teeth, roots and canal)
  { lo: 0, hi: 2400, shade: 0, layers: [1, 2, 3, 4, 6] },         // x-ray (MIP)
  { lo: -500, hi: 2500, shade: 0, layers: [1, 2, 3, 4, 5, 6, 7] }, // slices
];

export function createUI(state, h) {
  function sync() {
    for (const b of document.querySelectorAll("#modes button")) b.setAttribute("aria-pressed", String(+b.dataset.mode === state.mode));
    for (const b of document.querySelectorAll("#axes button")) b.setAttribute("aria-pressed", String(+b.dataset.axis === state.axis));
    const slices = state.mode === MODE.SLICE;
    $("axes").hidden = !slices; $("sliceRow").hidden = !slices; $("cutRow").hidden = slices;
    $("layers").hidden = slices || !$("layers").children.length;
    for (const b of $("layers").children) b.setAttribute("aria-pressed", String(state.layers.has(+b.dataset.id)));
    $("shadeRow").hidden = state.mode >= MODE.MIP;
    $("lo").value = state.lo; $("hi").value = state.hi; $("shade").value = state.shade;
    $("loV").textContent = Math.round(state.lo); $("hiV").textContent = Math.round(state.hi);
    $("cut").value = state.cut; $("slice").value = state.slice;
    $("hint").textContent = slices
      ? "Drag up/down to scroll slices · pinch to zoom · two fingers to pan · double-tap to reset"
      : "Drag to rotate · pinch to zoom · two fingers to pan · double-tap to reset";
  }
  function applyPreset() {
    const p = PRESETS[state.mode];
    state.lo = p.lo; state.hi = p.hi; state.shade = p.shade || state.shade;
    state.layers = new Set(p.layers);
    sync();
    h.onLayers();
  }
  function setSlice(v) { state.slice = Math.min(Math.max(v, 0), 1); $("slice").value = state.slice; h.poke(); }

  // Anatomy toggles from the manifest's label legend.
  function setLegend(legend) {
    $("layers").replaceChildren(...legend.map((l) => {
      const b = document.createElement("button");
      b.className = "chip"; b.dataset.id = l.id;
      const dot = document.createElement("i");
      dot.style.background = `rgb(${l.color.map((c) => Math.round(c * 255)).join(",")})`;
      b.append(dot, l.name);
      b.onclick = () => {
        state.layers.has(l.id) ? state.layers.delete(l.id) : state.layers.add(l.id);
        sync(); h.onLayers();
      };
      return b;
    }));
    sync();
  }

  // Quality levels from the manifest; `def` is this device's default.
  function setLevels(levels, def) {
    $("quality").replaceChildren(...levels.map((l) => {
      const b = document.createElement("button");
      b.className = "opt"; b.dataset.id = l.id;
      b.innerHTML = `<b></b><span class="d"></span><span class="mb"></span>`;
      b.querySelector("b").textContent = l.label;
      b.querySelector(".d").textContent = l.title || "";
      b.querySelector(".mb").textContent = `${(l.bytes / 1e6).toFixed(1)} MB`;
      if (l.id === def) { const t = document.createElement("span"); t.className = "tag"; t.textContent = "default"; b.querySelector("b").appendChild(t); }
      b.onclick = () => h.onLevel(l.id);
      return b;
    }));
  }
  function markLevel(id) { for (const b of $("quality").children) b.setAttribute("aria-pressed", String(b.dataset.id === id)); }

  document.querySelectorAll("#modes button").forEach((b) => b.onclick = () => {
    const m = +b.dataset.mode;
    if (m === state.mode) return;
    state.mode = m; applyPreset(); h.poke();
  });
  document.querySelectorAll("#axes button").forEach((b) => b.onclick = () => {
    state.axis = +b.dataset.axis; h.onAxis(); sync(); h.poke();
  });
  $("cut").oninput = () => { state.cut = +$("cut").value; h.poke(); };
  $("slice").oninput = () => setSlice(+$("slice").value);
  $("lo").oninput = () => { state.lo = Math.min(+$("lo").value, state.hi - 10); $("loV").textContent = Math.round(state.lo); h.poke(); };
  $("hi").oninput = () => { state.hi = Math.max(+$("hi").value, state.lo + 10); $("hiV").textContent = Math.round(state.hi); h.poke(); };
  $("shade").oninput = () => { state.shade = +$("shade").value; h.poke(); };
  $("moreBtn").onclick = () => {
    const open = $("panel").classList.toggle("open");
    $("moreBtn").setAttribute("aria-pressed", String(open));
  };
  $("gearBtn").onclick = () => {
    const open = $("settings").hidden;
    $("settings").hidden = !open;
    $("gearBtn").setAttribute("aria-pressed", String(open));
  };
  // Sharp only matters above the 2x cap used when the view is still (e.g. 3x iPhone screens).
  $("sharpRow").hidden = !((window.devicePixelRatio || 1) > 2);
  $("sharp").onchange = () => { state.hiDpi = $("sharp").checked; h.poke(); };
  $("resetBtn").onclick = () => h.onReset();

  return { sync, applyPreset, setSlice, setLegend, setLevels, markLevel };
}
