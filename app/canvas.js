/* =========================================================================
   画布引擎：视口（平移 / 缩放）、节点渲染、连线、拖拽、框选、快捷键
   ========================================================================= */
import {
  state, onChange, emit, getNode, inputsOf, addNode, removeNodes, connect, canConnect, disconnect,
  checkpoint, endGesture, markDirty, viewChanged, undo, redo, copySelection, pasteClip, KIND_LABEL, NODE_SIZE,
} from "./store.js";
import { h, icon, menu, toast, closePopover, popoverOpen, fileUrl, fmtClock } from "./ui.js";
import { ROLE_LABEL } from "../lib/seedance.js";

let root, world, edgeSvg, nodeLayer, marquee, hud;
const nodeEls = new Map();
const hooks = {};   // 由 main.js 注入：onSelect, onQuick, onDropFiles, onDropAsset, nodeBody
let drag = null;
let spaceDown = false;
let clipboard = null;

export const ZMIN = 0.15, ZMAX = 2.5;

export function initCanvas(el, h_) {
  Object.assign(hooks, h_);
  root = el;
  world = h("div", { class: "world" });
  edgeSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  edgeSvg.classList.add("edges");
  edgeSvg.innerHTML = `<defs>
    <linearGradient id="flow" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="80" y2="0" spreadMethod="repeat">
      <stop offset="0" stop-color="#4a9dff" stop-opacity="0"/><stop offset=".5" stop-color="#5aa8ff"/>
      <stop offset="1" stop-color="#4a9dff" stop-opacity="0"/></linearGradient></defs><g class="edge-g"></g><g class="edge-temp"></g>`;
  nodeLayer = h("div", { class: "nodes" });
  world.append(edgeSvg, nodeLayer);
  marquee = h("div", { class: "marquee" });
  root.append(world, marquee);

  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("dblclick", onDblClick);
  root.addEventListener("contextmenu", onContextMenu);
  root.addEventListener("dragover", (e) => { e.preventDefault(); root.classList.add("drop-hot"); });
  root.addEventListener("dragleave", (e) => { if (e.target === root) root.classList.remove("drop-hot"); });
  root.addEventListener("drop", onDrop);
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", (e) => { if (e.code === "Space") { spaceDown = false; root.classList.remove("panning"); } });
  window.addEventListener("resize", () => emit("view"));

  onChange((reason) => {
    // view / move 是本模块自己发出的通知（给面板定位用），不能再触发重绘，否则无限递归
    if (["dirty", "saving", "saved", "view", "move", "inputs", "task"].includes(reason)) return;
    render();
  });
  render();
}

/* =========================================================
   坐标
   ========================================================= */
export function toWorld(cx, cy) {
  const r = root.getBoundingClientRect();
  return { x: (cx - r.left - state.view.x) / state.view.z, y: (cy - r.top - state.view.y) / state.view.z };
}
export function toScreen(wx, wy) {
  const r = root.getBoundingClientRect();
  return { x: wx * state.view.z + state.view.x + r.left, y: wy * state.view.z + state.view.y + r.top };
}
function applyView() {
  const { x, y, z } = state.view;
  world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  root.style.backgroundPosition = `${x}px ${y}px`;
  const g = 22 * z;
  root.style.backgroundSize = `${g}px ${g}px`;
  root.style.setProperty("--dot", z < 0.35 ? "transparent" : "rgba(255,255,255,.075)");
  emit("view");
}
export function setView(v, save = true) {
  state.view = { ...state.view, ...v };
  state.view.z = Math.min(ZMAX, Math.max(ZMIN, state.view.z));
  applyView();
  if (save) viewChanged();
}
export function zoomAt(cx, cy, factor) {
  const r = root.getBoundingClientRect();
  const px = cx - r.left, py = cy - r.top;
  const z = Math.min(ZMAX, Math.max(ZMIN, state.view.z * factor));
  const k = z / state.view.z;
  setView({ z, x: px - (px - state.view.x) * k, y: py - (py - state.view.y) * k });
}
export function zoomBy(factor) {
  const r = root.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
}

export function fitView(ids) {
  const list = ids?.length ? ids.map(getNode).filter(Boolean) : state.nodes;
  const r = root.getBoundingClientRect();
  if (!list.length) { setView({ x: r.width / 2 - 200, y: r.height / 2 - 160, z: 1 }); return; }
  const x0 = Math.min(...list.map(n => n.x)) - 60, y0 = Math.min(...list.map(n => n.y)) - 90;
  const x1 = Math.max(...list.map(n => n.x + n.w)) + 60, y1 = Math.max(...list.map(n => n.y + n.h)) + 300;
  const z = Math.min(1.2, Math.max(ZMIN, Math.min(r.width / (x1 - x0), r.height / (y1 - y0))));
  setView({ z, x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z });
}

/** 让某个节点进入视野 */
export function focusNode(id) {
  const n = getNode(id); if (!n) return;
  const r = root.getBoundingClientRect();
  const z = Math.max(0.6, Math.min(1, state.view.z));
  setView({ z, x: r.width / 2 - (n.x + n.w / 2) * z, y: r.height / 3 - (n.y + n.h / 2) * z });
  select([id]);
}

export function viewportCenter() {
  const r = root.getBoundingClientRect();
  return toWorld(r.left + r.width / 2, r.top + r.height / 2);
}

/* =========================================================
   选择
   ========================================================= */
export function select(ids, additive = false) {
  if (!additive) state.selection.clear();
  for (const id of ids) state.selection.add(id);
  render();
  hooks.onSelect?.([...state.selection]);
}
export function clearSelection() { if (state.selection.size) select([]); }

/* =========================================================
   渲染
   ========================================================= */
export function render() {
  applyView();
  const alive = new Set();
  for (const n of state.nodes) {
    alive.add(n.id);
    let el = nodeEls.get(n.id);
    if (!el) { el = buildNode(n); nodeEls.set(n.id, el); nodeLayer.appendChild(el); }
    updateNode(el, n);
  }
  for (const [id, el] of nodeEls) if (!alive.has(id)) { el.remove(); nodeEls.delete(id); }
  renderEdges();
}

export function rerenderNode(id) {
  const n = getNode(id), el = nodeEls.get(id);
  if (n && el) { el._sig = null; updateNode(el, n); }
  renderEdges();
}

function buildNode(n) {
  const el = h("div", { class: `node k-${n.kind}`, dataset: { id: n.id } });
  const title = h("div", { class: "node-title" }, icon(KIND_ICON[n.kind], 14), h("span", { class: "t" }));
  title.addEventListener("dblclick", (e) => { e.stopPropagation(); renameNode(n.id, title.querySelector(".t")); });
  const card = h("div", { class: "card" });
  const pin = h("button", { class: "port in", title: "输入：拖出连线，或点击添加素材", dataset: { port: "in" } }, icon("plus", 14));
  const pout = h("button", { class: "port out", title: "输出：拖到视频节点上连接", dataset: { port: "out" } }, icon("plus", 14));
  const badge = h("div", { class: "badge" });
  const resize = h("div", { class: "resize", title: "拖动调整大小" });
  el.append(title, card, pin, pout, badge, resize);
  return el;
}

const KIND_ICON = { video: "play", image: "image", text: "text", audio: "audio" };

function updateNode(el, n) {
  el.style.transform = `translate(${n.x}px, ${n.y}px)`;
  el.style.width = n.w + "px";
  el.querySelector(".card").style.height = n.h + "px";
  el.classList.toggle("selected", state.selection.has(n.id));
  el.querySelector(".port.in").style.display = n.kind === "video" ? "" : "none";
  el.querySelector(".node-title .t").textContent = n.title;

  const task = n.data?.task;
  el.classList.toggle("running", !!task && task.phase === "run");
  const err = n.kind === "video" ? hooks.nodeError?.(n) : null;
  el.classList.toggle("invalid", !!err);

  // 内容只在关键数据变化时重建，避免视频播放被打断
  const sig = JSON.stringify([n.kind, n.data?.file, n.data?.url, n.data?.text, n.data?.results?.length,
                              n.data?.active, n.data?.results?.[n.data?.active || 0]?.file, task?.phase,
                              n.data?.mode, n.data?.lastError]);
  if (el._sig !== sig) {
    el._sig = sig;
    const card = el.querySelector(".card");
    card.replaceChildren(hooks.nodeBody?.(n) || h("div"));
  }
  const badge = el.querySelector(".badge");
  badge.replaceChildren(...(hooks.nodeBadge?.(n) || []));
}

function renameNode(id, span) {
  const n = getNode(id); if (!n) return;
  const input = h("input", { class: "rename", value: n.title });
  span.replaceWith(input);
  input.focus(); input.select();
  const done = (ok) => {
    const v = input.value.trim();
    if (ok && v && v !== n.title) { checkpoint(); n.title = v; markDirty(); }
    input.replaceWith(span);
    render();
  };
  input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
  input.addEventListener("blur", () => done(true));
}

/* ---------- 连线 ---------- */
function portPos(n, side) {
  return { x: side === "out" ? n.x + n.w + 18 : n.x - 18, y: n.y + n.h / 2 + 34 };
}
function curve(a, b) {
  const dx = Math.max(60, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

export function renderEdges() {
  const g = edgeSvg.querySelector(".edge-g");
  const frag = document.createDocumentFragment();
  for (const e of state.edges) {
    const a = getNode(e.from), b = getNode(e.to);
    if (!a || !b) continue;
    const d = curve(portPos(a, "out"), portPos(b, "in"));
    const running = b.data?.task?.phase === "run";
    const role = hooks.edgeRole?.(e);
    const grp = document.createElementNS("http://www.w3.org/2000/svg", "g");
    grp.setAttribute("class", "edge" + (running ? " running" : "") + (state.selection.has(e.from) || state.selection.has(e.to) ? " hl" : ""));
    grp.dataset.id = e.id;
    grp.innerHTML = `<path class="hit" d="${d}"/><path class="base" d="${d}"/><path class="flow" d="${d}"/>`;
    frag.appendChild(grp);
    if (role) {
      const pa = portPos(a, "out"), pb = portPos(b, "in");
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("class", "edge-label");
      t.setAttribute("x", (pa.x + pb.x) / 2); t.setAttribute("y", (pa.y + pb.y) / 2 - 8);
      t.textContent = role;
      frag.appendChild(t);
    }
  }
  g.replaceChildren(frag);
}

/* =========================================================
   指针交互
   ========================================================= */
function onPointerDown(e) {
  if (e.button === 2) return;
  if (popoverOpen() && !e.target.closest(".pop")) closePopover();
  const port = e.target.closest(".port");
  const nodeEl = e.target.closest(".node");
  const edgeEl = e.target.closest(".edge");
  const interactive = e.target.closest("input, textarea, select, button:not(.port), video, audio, a, [contenteditable], .no-drag");

  // 平移：中键 / 空格 / 在空白处按住并拖动右键之外
  if (e.button === 1 || (spaceDown && e.button === 0)) {
    e.preventDefault();
    startPan(e);
    return;
  }

  if (port) {
    e.preventDefault(); e.stopPropagation();
    startWire(e, port.closest(".node").dataset.id, port.dataset.port);
    return;
  }
  if (edgeEl) {
    e.preventDefault();
    const id = edgeEl.dataset.id;
    menu(null, [
      { label: "删除连线", icon: "trash", danger: true, onClick: () => disconnect(id) },
    ], { at: { x: e.clientX, y: e.clientY } });
    return;
  }
  if (nodeEl) {
    const id = nodeEl.dataset.id;
    if (e.target.closest(".resize")) { e.preventDefault(); startResize(e, id); return; }
    if (interactive) {
      if (!state.selection.has(id)) select([id]);
      return;
    }
    e.preventDefault();
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      if (state.selection.has(id)) { state.selection.delete(id); render(); hooks.onSelect?.([...state.selection]); }
      else select([id], true);
      return;
    }
    if (!state.selection.has(id)) select([id]);
    startMove(e);
    return;
  }
  if (e.target.closest(".panel, .gen, .hud, .drawer, .topbar, .pop, .modal-back")) return;

  // 空白处：左键拖动 = 框选；按住 Alt / 触控板手势走 wheel
  e.preventDefault();
  if (e.altKey) { startPan(e); return; }
  startMarquee(e);
}

function startPan(e) {
  root.classList.add("panning");
  const sx = e.clientX, sy = e.clientY, vx = state.view.x, vy = state.view.y;
  drag = { type: "pan" };
  track(e, (m) => setView({ x: vx + m.clientX - sx, y: vy + m.clientY - sy }, false),
        () => { root.classList.remove("panning"); viewChanged(); });
}

function startMove(e) {
  const start = toWorld(e.clientX, e.clientY);
  const orig = [...state.selection].map(id => getNode(id)).filter(Boolean).map(n => ({ n, x: n.x, y: n.y }));
  let moved = false;
  drag = { type: "move" };
  track(e, (m) => {
    const p = toWorld(m.clientX, m.clientY);
    const dx = p.x - start.x, dy = p.y - start.y;
    if (!moved && Math.hypot(dx, dy) < 3 / state.view.z) return;
    if (!moved) { checkpoint("move"); moved = true; }
    for (const o of orig) { o.n.x = Math.round(o.x + dx); o.n.y = Math.round(o.y + dy); }
    for (const o of orig) { const el = nodeEls.get(o.n.id); if (el) el.style.transform = `translate(${o.n.x}px, ${o.n.y}px)`; }
    renderEdges();
    emit("move");
  }, () => { if (moved) { endGesture(); markDirty(); } });
}

function startResize(e, id) {
  const n = getNode(id);
  const start = toWorld(e.clientX, e.clientY);
  const w0 = n.w, h0 = n.h;
  const min = { video: [260, 146], image: [140, 100], text: [180, 100], audio: [200, 90] }[n.kind] || [140, 90];
  const ratio = n.kind === "video" ? h0 / w0 : null;
  checkpoint("resize-" + id);
  track(e, (m) => {
    const p = toWorld(m.clientX, m.clientY);
    n.w = Math.max(min[0], Math.round(w0 + p.x - start.x));
    n.h = ratio ? Math.round(n.w * ratio) : Math.max(min[1], Math.round(h0 + p.y - start.y));
    const el = nodeEls.get(id);
    el.style.width = n.w + "px"; el.querySelector(".card").style.height = n.h + "px";
    renderEdges(); emit("move");
  }, () => { endGesture(); markDirty(); });
}

function startMarquee(e) {
  const r = root.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  const base = additive ? new Set(state.selection) : new Set();
  let active = false;
  track(e, (m) => {
    const x = m.clientX - r.left, y = m.clientY - r.top;
    if (!active && Math.hypot(x - sx, y - sy) < 4) return;
    active = true;
    const x0 = Math.min(sx, x), y0 = Math.min(sy, y), w = Math.abs(x - sx), hh = Math.abs(y - sy);
    Object.assign(marquee.style, { display: "block", left: x0 + "px", top: y0 + "px", width: w + "px", height: hh + "px" });
    const a = toWorld(x0 + r.left, y0 + r.top), b = toWorld(x0 + w + r.left, y0 + hh + r.top);
    state.selection = new Set(base);
    for (const n of state.nodes)
      if (n.x < b.x && n.x + n.w > a.x && n.y - 30 < b.y && n.y + n.h > a.y) state.selection.add(n.id);
    for (const [id, el] of nodeEls) el.classList.toggle("selected", state.selection.has(id));
  }, () => {
    marquee.style.display = "none";
    if (!active) { clearSelection(); return; }
    render(); hooks.onSelect?.([...state.selection]);
  });
}

/* ---------- 拉线 ---------- */
function startWire(e, nodeId, side) {
  const n = getNode(nodeId);
  const temp = edgeSvg.querySelector(".edge-temp");
  const origin = portPos(n, side);
  let moved = false;
  const sx = e.clientX, sy = e.clientY;
  root.classList.add("wiring", side === "out" ? "wiring-out" : "wiring-in");
  // 高亮可连的节点
  for (const m of state.nodes) {
    const ok = side === "out" ? !canConnect(nodeId, m.id) : !canConnect(m.id, nodeId);
    nodeEls.get(m.id)?.classList.toggle("can-drop", ok && m.id !== nodeId);
  }
  track(e, (m) => {
    if (!moved && Math.hypot(m.clientX - sx, m.clientY - sy) < 4) return;
    moved = true;
    const p = toWorld(m.clientX, m.clientY);
    const d = side === "out" ? curve(origin, p) : curve(p, origin);
    temp.innerHTML = `<path class="temp" d="${d}"/>`;
  }, (up) => {
    temp.innerHTML = "";
    root.classList.remove("wiring", "wiring-out", "wiring-in");
    for (const el of nodeEls.values()) el.classList.remove("can-drop");
    const p = toWorld(up.clientX, up.clientY);
    const target = !moved ? null : hitNode(up);
    if (target && target !== nodeId) {
      const err = side === "out" ? connect(nodeId, target) : connect(target, nodeId);
      if (err) toast(err, "warn");
      return;
    }
    // 点击端口 / 松在空白处：弹出新建菜单
    const at = moved ? p : (side === "out" ? { x: n.x + n.w + 90, y: n.y } : { x: n.x - 90 - 280, y: n.y });
    spawnMenu(up.clientX, up.clientY, at, { nodeId, side });
  });
}

function hitNode(ev) {
  const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".node");
  return el?.dataset.id || null;
}

/** 新建节点菜单：from 存在时新节点自动连线 */
export function spawnMenu(cx, cy, at, from = null) {
  const items = [];
  const link = (kind) => {
    if (!from) return;
    return from.side === "out" ? [from.nodeId, null] : [null, from.nodeId];
  };
  const make = (kind, extra) => {
    const sz = NODE_SIZE[kind];
    let x = at.x, y = at.y;
    if (from?.side === "in") x = at.x - (from ? 0 : sz.w / 2);
    const n = addNode(kind, x, y, extra);
    if (from) {
      const err = from.side === "out" ? connect(from.nodeId, n.id) : connect(n.id, from.nodeId);
      if (err) toast(err, "warn");
    }
    select([n.id]);
    return n;
  };
  if (!from || from.side === "out") {
    const src = from && getNode(from.nodeId);
    items.push({ title: from ? "连接到新节点" : "添加节点" });
    items.push({ label: "视频", icon: "play", hint: src?.kind === "video" ? "续写" : "", onClick: () => make("video") });
    if (!from) {
      items.push({ label: "文本", icon: "text", onClick: () => make("text") });
      items.push({ label: "图片", icon: "image", onClick: () => hooks.onQuick?.("pick-image", { at }) });
      items.push({ label: "音频", icon: "audio", onClick: () => hooks.onQuick?.("pick-audio", { at }) });
      items.push({ label: "视频素材 / 外链", icon: "link", onClick: () => hooks.onQuick?.("pick-video", { at }) });
    }
  } else {
    items.push({ title: "添加输入" });
    items.push({ label: "文本（提示词）", icon: "text", onClick: () => make("text") });
    items.push({ label: "图片", icon: "image", onClick: () => hooks.onQuick?.("pick-image", { at, link: from.nodeId }) });
    items.push({ label: "从资源库选", icon: "library", onClick: () => hooks.onQuick?.("library", { at, link: from.nodeId }) });
    items.push({ label: "音频", icon: "audio", onClick: () => hooks.onQuick?.("pick-audio", { at, link: from.nodeId }) });
    items.push({ label: "参考视频外链", icon: "link", onClick: () => hooks.onQuick?.("pick-video", { at, link: from.nodeId }) });
    items.push({ label: "视频（续写上一段）", icon: "continue", onClick: () => {
      const n = addNode("video", at.x - 120, at.y, {});
      n.data.params.returnLastFrame = true;
      const err = connect(n.id, from.nodeId);
      if (err) toast(err, "warn");
      select([n.id]);
    } });
  }
  menu(null, items, { at: { x: cx, y: cy } });
}

function track(e, move, up) {
  const pid = e.pointerId;
  try { root.setPointerCapture(pid); } catch {}
  const mv = (m) => { if (m.pointerId === pid) move(m); };
  const end = (u) => {
    if (u.pointerId !== pid) return;
    root.removeEventListener("pointermove", mv);
    root.removeEventListener("pointerup", end);
    root.removeEventListener("pointercancel", end);
    try { root.releasePointerCapture(pid); } catch {}
    drag = null;
    up(u);
  };
  root.addEventListener("pointermove", mv);
  root.addEventListener("pointerup", end);
  root.addEventListener("pointercancel", end);
}

/* ---------- 滚轮：触控板双指平移，Ctrl/⌘ 或捏合缩放，鼠标滚轮缩放 ---------- */
function onWheel(e) {
  if (e.target.closest(".gen, .drawer, .pop, .modal-back, textarea, .scroll")) return;
  e.preventDefault();
  const isPinch = e.ctrlKey || e.metaKey;
  const isTrackpad = !isPinch && (Math.abs(e.deltaX) > 0 || (e.deltaMode === 0 && Math.abs(e.deltaY) < 50 && !Number.isInteger(e.deltaY / 100)));
  if (isPinch) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
  else if (isTrackpad) setView({ x: state.view.x - e.deltaX, y: state.view.y - e.deltaY });
  else zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
}

function onDblClick(e) {
  if (e.target.closest(".node, .gen, .hud, .drawer, .topbar, .pop, .modal-back, .panel")) return;
  const at = toWorld(e.clientX, e.clientY);
  spawnMenu(e.clientX, e.clientY, { x: at.x - 140, y: at.y - 40 });
}

function onContextMenu(e) {
  e.preventDefault();
  const nodeEl = e.target.closest(".node");
  if (nodeEl) {
    const id = nodeEl.dataset.id;
    if (!state.selection.has(id)) select([id]);
    const n = getNode(id);
    const items = [];
    if (n.kind === "video") items.push({ label: "生成", icon: "up", onClick: () => hooks.onQuick?.("generate", { id }) });
    items.push(
      { label: "复制", icon: "copy", hint: "⌘C", onClick: () => { clipboard = copySelection(); } },
      { label: "创建副本", icon: "layers", hint: "⌘D", onClick: duplicate },
      { label: "重命名", onClick: () => renameNode(id, nodeEls.get(id).querySelector(".node-title .t")) },
      "-",
      { label: "删除", icon: "trash", danger: true, hint: "⌫", onClick: () => removeNodes([...state.selection]) },
    );
    menu(null, items, { at: { x: e.clientX, y: e.clientY } });
    return;
  }
  if (e.target.closest(".gen, .drawer, .topbar, .hud, .pop")) return;
  const at = toWorld(e.clientX, e.clientY);
  const items = [{ title: "画布" }];
  if (clipboard) items.push({ label: "粘贴", hint: "⌘V", onClick: () => { pasteAt(at); } });
  items.push(
    { label: "添加节点…", icon: "plus", onClick: () => spawnMenu(e.clientX, e.clientY, { x: at.x - 140, y: at.y - 40 }) },
    { label: "适配视图", icon: "fit", hint: "⌘0", onClick: () => fitView() },
  );
  menu(null, items, { at: { x: e.clientX, y: e.clientY } });
}

function pasteAt(at) {
  if (!clipboard) return;
  const clip = JSON.parse(clipboard);
  const x0 = Math.min(...clip.nodes.map(n => n.x)), y0 = Math.min(...clip.nodes.map(n => n.y));
  for (const n of clip.nodes) { n.x += at.x - x0; n.y += at.y - y0; }
  pasteClip(JSON.stringify(clip), 0);
  hooks.onSelect?.([...state.selection]);
}

function duplicate() {
  const c = copySelection(); if (!c) return;
  pasteClip(c, 40);
  hooks.onSelect?.([...state.selection]);
}

async function onDrop(e) {
  e.preventDefault();
  root.classList.remove("drop-hot");
  const at = toWorld(e.clientX, e.clientY);
  const assetId = e.dataTransfer.getData("application/x-seedance-asset");
  if (assetId) { hooks.onDropAsset?.(assetId, at); return; }
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) hooks.onDropFiles?.(files, at);
}

/* ---------- 快捷键 ---------- */
function onKey(e) {
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  if (document.querySelector(".modal-back")) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.code === "Space" && !spaceDown) { spaceDown = true; root.classList.add("panning"); e.preventDefault(); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && state.selection.size) {
    e.preventDefault(); removeNodes([...state.selection]); hooks.onSelect?.([]); return;
  }
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); (e.shiftKey ? redo() : undo()); hooks.onSelect?.([...state.selection]); return; }
  if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); select(state.nodes.map(n => n.id)); return; }
  if (mod && e.key.toLowerCase() === "c") { clipboard = copySelection(); if (clipboard) toast(`已复制 ${state.selection.size} 个节点`, "ok", 1200); return; }
  if (mod && e.key.toLowerCase() === "v" && clipboard) { e.preventDefault(); pasteClip(clipboard, 40); clipboard = copySelection(); hooks.onSelect?.([...state.selection]); return; }
  if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(); return; }
  if (mod && e.key === "0") { e.preventDefault(); fitView(); return; }
  if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomBy(1.2); return; }
  if (mod && e.key === "-") { e.preventDefault(); zoomBy(1 / 1.2); return; }
  if (e.key === "Escape") { clearSelection(); }
}

export function nodeElement(id) { return nodeEls.get(id); }
export function canvasRoot() { return root; }
export { fmtClock, ROLE_LABEL };
