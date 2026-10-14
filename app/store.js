/* =========================================================================
   画布状态：节点、连线、视口；撤销 / 重做；自动保存到项目文件夹
   ========================================================================= */
import { DEFAULT_PARAMS } from "../lib/seedance.js";

export const NODE_SIZE = {
  video: { w: 400, h: 225 },
  image: { w: 260, h: 260 },
  text:  { w: 280, h: 200 },
  audio: { w: 280, h: 120 },
};

export const KIND_LABEL = { video: "视频节点", image: "图片节点", text: "文本节点", audio: "音频节点" };

const listeners = new Set();
let saveTimer = null;
let dirtyWhileSaving = false;

export const state = {
  nodes: [],            // { id, kind, x, y, w, h, title, data }
  edges: [],            // { id, from, to }   from/to = 节点 id，方向：from 右端口 → to 左端口
  view: { x: 0, y: 0, z: 1 },
  selection: new Set(),
  counters: { video: 0, image: 0, text: 0, audio: 0 },
  project: null,        // { name, path }
  saveState: "saved",   // saved | dirty | saving | error
};

export const history = { past: [], future: [] };

export function uid(prefix = "n") {
  return prefix + "_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
}

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(reason = "change") { for (const fn of listeners) fn(reason); }

export function getNode(id) { return state.nodes.find(n => n.id === id); }
export function inputsOf(id) {
  return state.edges.filter(e => e.to === id).map(e => getNode(e.from)).filter(Boolean);
}
export function outputsOf(id) {
  return state.edges.filter(e => e.from === id).map(e => getNode(e.to)).filter(Boolean);
}

/* ---------- 序列化 ---------- */
function snapshot() {
  return JSON.stringify({ nodes: state.nodes, edges: state.edges, counters: state.counters });
}

export function serialize() {
  return {
    version: 1,
    savedAt: Date.now(),
    view: state.view,
    counters: state.counters,
    nodes: state.nodes.map(n => ({
      ...n,
      // 不落盘的运行时字段
      data: Object.fromEntries(Object.entries(n.data || {}).filter(([k]) => !k.startsWith("_"))),
    })),
    edges: state.edges,
  };
}

export function load(doc) {
  state.nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  state.edges = Array.isArray(doc?.edges) ? doc.edges.filter(e => e.from && e.to) : [];
  state.view = doc?.view && Number.isFinite(doc.view.z) ? doc.view : { x: 0, y: 0, z: 1 };
  state.counters = { video: 0, image: 0, text: 0, audio: 0, ...(doc?.counters || {}) };
  for (const n of state.nodes) {
    n.data = n.data || {};
    if (n.kind === "video") n.data.params = { ...DEFAULT_PARAMS, ...(n.data.params || {}) };
    const sz = NODE_SIZE[n.kind] || NODE_SIZE.text;
    n.w = n.w || sz.w; n.h = n.h || sz.h;
  }
  state.selection = new Set();
  history.past = []; history.future = [];
  state.saveState = "saved";
  emit("load");
}

/* ---------- 撤销 ---------- */
let pending = null;
/** 在一次修改开始前调用；同一 key 的连续修改（如拖拽）合并成一步 */
export function checkpoint(key = null) {
  if (key && pending === key) return;
  pending = key;
  history.past.push(snapshot());
  if (history.past.length > 100) history.past.shift();
  history.future = [];
}
export function endGesture() { pending = null; }

function restore(snap) {
  const d = JSON.parse(snap);
  state.nodes = d.nodes; state.edges = d.edges; state.counters = d.counters;
  for (const id of [...state.selection]) if (!getNode(id)) state.selection.delete(id);
}
export function undo() {
  if (!history.past.length) return false;
  history.future.push(snapshot());
  restore(history.past.pop());
  pending = null;
  markDirty(); emit("undo");
  return true;
}
export function redo() {
  if (!history.future.length) return false;
  history.past.push(snapshot());
  restore(history.future.pop());
  pending = null;
  markDirty(); emit("undo");
  return true;
}

/* ---------- 增删 ---------- */
export function addNode(kind, x, y, data = {}, opts = {}) {
  if (!opts.noCheckpoint) checkpoint();
  const sz = NODE_SIZE[kind] || NODE_SIZE.text;
  state.counters[kind] = (state.counters[kind] || 0) + 1;
  const n = {
    id: uid(kind[0]),
    kind,
    x: Math.round(x), y: Math.round(y),
    w: opts.w || sz.w, h: opts.h || sz.h,
    title: opts.title || `${KIND_LABEL[kind]} ${state.counters[kind]}`,
    data: kind === "video"
      ? { mode: "t2v", prompt: "", params: { ...DEFAULT_PARAMS }, results: [], active: 0, ...data }
      : { ...data },
  };
  state.nodes.push(n);
  markDirty(); emit("add");
  return n;
}

export function removeNodes(ids) {
  const set = new Set(ids);
  if (!set.size) return;
  checkpoint();
  state.nodes = state.nodes.filter(n => !set.has(n.id));
  state.edges = state.edges.filter(e => !set.has(e.from) && !set.has(e.to));
  for (const id of set) state.selection.delete(id);
  markDirty(); emit("remove");
}

/** 连线规则：不能自连、不能重复、不能成环；只有视频节点能接收输入 */
export function canConnect(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return "不能连到自己";
  const from = getNode(fromId), to = getNode(toId);
  if (!from || !to) return "节点不存在";
  if (to.kind !== "video") return "只有视频节点可以接收输入";
  if (from.kind === "video" && !from.data?.params?.returnLastFrame && !hasLastFrame(from))
    return "上游视频要开启「返回尾帧」才能续写";
  if (state.edges.some(e => e.from === fromId && e.to === toId)) return "已经连过了";
  // 成环检测
  const stack = [toId], seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === fromId) return "不能形成循环";
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of state.edges) if (e.from === id) stack.push(e.to);
  }
  return null;
}

function hasLastFrame(n) {
  return (n.data?.results || []).some(r => r.lastFrameFile || r.lastFrameUrl);
}

export function connect(fromId, toId) {
  const err = canConnect(fromId, toId);
  if (err) return err;
  checkpoint();
  state.edges.push({ id: uid("e"), from: fromId, to: toId });
  markDirty(); emit("connect");
  return null;
}

export function disconnect(edgeId) {
  checkpoint();
  state.edges = state.edges.filter(e => e.id !== edgeId);
  markDirty(); emit("disconnect");
}

/** 复制：连同选区内部的连线 */
export function copySelection() {
  const ids = new Set(state.selection);
  if (!ids.size) return null;
  return JSON.stringify({
    kind: "seedance-canvas-clip",
    nodes: state.nodes.filter(n => ids.has(n.id)),
    edges: state.edges.filter(e => ids.has(e.from) && ids.has(e.to)),
  });
}

export function pasteClip(text, offset = 40) {
  let clip;
  try { clip = JSON.parse(text); } catch { return false; }
  if (clip?.kind !== "seedance-canvas-clip" || !Array.isArray(clip.nodes)) return false;
  checkpoint();
  const map = {};
  state.selection.clear();
  for (const src of clip.nodes) {
    state.counters[src.kind] = (state.counters[src.kind] || 0) + 1;
    const n = JSON.parse(JSON.stringify(src));
    n.id = uid(src.kind[0]);
    n.x += offset; n.y += offset;
    n.title = `${KIND_LABEL[n.kind]} ${state.counters[n.kind]}`;
    // 复制出来的视频节点不带任务和结果，避免两个节点抢同一个任务
    if (n.kind === "video") { n.data.results = []; n.data.active = 0; delete n.data.task; }
    map[src.id] = n.id;
    state.nodes.push(n);
    state.selection.add(n.id);
  }
  for (const e of clip.edges || []) if (map[e.from] && map[e.to])
    state.edges.push({ id: uid("e"), from: map[e.from], to: map[e.to] });
  markDirty(); emit("paste");
  return true;
}

/* ---------- 保存 ---------- */
export function markDirty() {
  state.saveState = "dirty";
  emit("dirty");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 800);
}

/** 保存当前状态。正在保存时再调用，会排队并等到最新状态落盘后才返回。 */
let inflight = null;
export function flush() {
  clearTimeout(saveTimer);
  if (!state.project) return Promise.resolve();
  if (inflight) { dirtyWhileSaving = true; return inflight.then(() => (dirtyWhileSaving ? flush() : undefined)); }
  inflight = (async () => {
    state.saveState = "saving"; emit("saving");
    try {
      const r = await fetch("/api/canvas", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(serialize()),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || `HTTP ${r.status}`);
      state.saveState = dirtyWhileSaving ? "dirty" : "saved";
    } catch (e) {
      state.saveState = "error";
      console.error("保存失败", e);
    } finally {
      inflight = null;
      emit("saved");
    }
  })();
  return inflight.then(() => {
    if (dirtyWhileSaving) { dirtyWhileSaving = false; return flush(); }
  });
}

/** 视口变化单独防抖保存，不进撤销栈 */
let viewTimer = null;
export function viewChanged() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { if (state.saveState === "saved") markDirty(); }, 1500);
}

window.addEventListener("beforeunload", (e) => {
  if (state.saveState === "dirty" || state.saveState === "saving") {
    flush();
    e.preventDefault();
    e.returnValue = "";
  }
});
