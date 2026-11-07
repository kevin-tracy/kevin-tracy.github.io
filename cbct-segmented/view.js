// Turntable camera and pointer/touch gestures. Azimuth spins about the head's vertical axis,
// elevation tilts toward the top/bottom of the head (clamped), never any roll.
import { quat, mat4mul, mat4inv, perspective } from "./math.js";

const FOVY = 30 * Math.PI / 180;
const MAX_EL = 85 * Math.PI / 180;

export function createView(canvas, state, { poke, setSlice, panelHeight }) {
  const v = { az: 0, el: 0, distance: 300, pan: [0, 0], sliceZoom: 1, slicePan: [0, 0], half: [1, 1, 1] };
  const radius = () => Math.hypot(...v.half);
  const orientation = () => quat.mul(quat.axisAngle([1, 0, 0], v.el), quat.axisAngle([0, 1, 0], v.az));

  function panelOffsetMM() {
    const h = canvas.clientHeight || 1;
    if (window.innerWidth >= 700) return 0;
    const mmPerPx = 2 * v.distance * Math.tan(FOVY / 2) / h;
    return (panelHeight() / 2) * mmPerPx * 0.8;
  }
  function reset() {
    v.az = 0; v.el = 0; // anterior view, superior up
    const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1) || 1;
    const ty = Math.tan(FOVY / 2), tx = ty * aspect;
    // Leave room for the control panel on phones.
    v.distance = Math.max(v.half[0] / tx, v.half[1] / ty) * 0.95 + v.half[2];
    v.pan = [0, panelOffsetMM()];
    v.sliceZoom = 1; v.slicePan = [0, 0];
  }

  // Uniform values for one frame (see renderer.draw).
  function params(w, h, ext, voxelMM, interactive) {
    const R = radius();
    const proj = perspective(FOVY, w / h, 1, v.distance + 2 * R);
    const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v.pan[0], v.pan[1], -v.distance, 1];
    const mvp = mat4mul(proj, mat4mul(view, quat.toMat4(orientation())));
    const fwd = quat.rotate(quat.conj(orientation()), [0, 0, -1]);
    const plane = state.axis === 0 ? [ext[0], ext[1]] : state.axis === 1 ? [ext[0], ext[2]] : [ext[1], ext[2]];
    const fit = Math.min(w / plane[0], h / plane[1]);
    return {
      invMVP: mat4inv(mvp), half: v.half, step: voxelMM * (interactive ? 1.0 : 0.5), fwd,
      cut: -R * 1.01 + state.cut * 2 * R,
      sliceXform: [(w / 2) / (fit * plane[0]) / v.sliceZoom, (h / 2) / (fit * plane[1]) / v.sliceZoom, v.slicePan[0], v.slicePan[1]],
    };
  }

  function rotateBy(dx, dy) {
    const k = 0.008;
    v.az = (v.az + dx * k) % (2 * Math.PI);
    v.el = Math.min(Math.max(v.el + dy * k, -MAX_EL), MAX_EL);
  }
  function panBy(dx, dy) {
    const H = canvas.clientHeight || 1;
    if (state.mode === 3) {
      const s = 1 / (H * v.sliceZoom);
      v.slicePan[0] -= dx * s; v.slicePan[1] += dy * s;
    } else {
      const mmPerPx = 2 * v.distance * Math.tan(FOVY / 2) / H;
      v.pan[0] += dx * mmPerPx; v.pan[1] -= dy * mmPerPx;
    }
  }
  function zoomBy(s) {
    if (!(s > 0)) return;
    if (state.mode === 3) v.sliceZoom = Math.min(Math.max(v.sliceZoom * s, 0.5), 12);
    else v.distance = Math.min(Math.max(v.distance / s, radius() * 0.3), radius() * 8);
  }

  const pointers = new Map();
  let gesture = null, lastTap = 0;
  const twoFinger = () => {
    const [a, b] = [...pointers.values()];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(b.x - a.x, b.y - a.y) };
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, button: e.button, shift: e.shiftKey });
    gesture = pointers.size === 2 ? twoFinger() : null;
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 1) {
      if (p.button === 2 || p.shift || p.button === 1) panBy(dx, dy);
      else if (state.mode === 3) { setSlice(state.slice - dy / (canvas.clientHeight || 1) * 0.5); return; }
      else rotateBy(dx, dy);
      poke();
    } else if (pointers.size === 2 && gesture) {
      const g = twoFinger();
      panBy(g.cx - gesture.cx, g.cy - gesture.cy);
      if (gesture.d > 0) zoomBy(g.d / gesture.d);
      gesture = g;
      poke();
    }
  });
  function endPointer(e) {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    gesture = pointers.size === 2 ? twoFinger() : null;
    if (p && e.type === "pointerup" && pointers.size === 0 && Math.hypot(p.x - p.x0, p.y - p.y0) < 8) {
      const now = performance.now();
      if (now - lastTap < 320) { reset(); poke(); lastTap = 0; } else lastTap = now;
    }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (state.mode === 3 && !e.ctrlKey) setSlice(state.slice - e.deltaY * 0.0005);
    else { zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))); poke(); }
  }, { passive: false });
  // Stop Safari's own pinch-zoom of the page.
  for (const ev of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(ev, (e) => e.preventDefault());

  return { v, reset, params };
}
