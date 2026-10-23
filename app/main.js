/* =========================================================================
   入口：项目（欢迎页 / 切换）、顶栏、资源库抽屉、设置，把各模块串起来
   ========================================================================= */
import { state, onChange, load, flush, addNode, connect, getNode, disconnect, markDirty, checkpoint, serialize } from "./store.js";
import {
  initCanvas, select, fitView, focusNode, viewportCenter, zoomBy, setView, rerenderNode, render, spawnMenu, toScreen, canvasRoot,
} from "./canvas.js";
import { h, $, icon, fill, toast, menu, modal, confirmDialog, api, fileUrl, pickFiles, fmtBytes, fmtTime, fmtYuan, copyText } from "./ui.js";
import { lib, refresh as refreshLib, upload, remove as removeAsset, reveal, onLibChange, kindOfFile, rename as renameAsset } from "./library.js";
import { nodeBody, nodeBadge, edgeRole, initPanel, showPanelFor, refreshPanel, positionPanel } from "./nodes.js";
import { getConn, setConn, loadLocalDefaults, generate, resumeAll, stopAllTimers, onTask, nodeIssue, isBusy } from "./generator.js";

const app = $("#app");

/* =========================================================
   顶栏
   ========================================================= */
const saveDot = h("span", { class: "save-dot", title: "" });
const projBtn = h("button", { class: "proj-btn", onclick: (e) => projectMenu(e.currentTarget) },
  icon("folder", 15), h("span", { class: "proj-name" }, "未打开项目"), icon("chevron", 12));
const topbar = h("div", { class: "topbar" },
  h("div", { class: "brand" }, h("span", { class: "logo" }, icon("play", 12)), "Seedance 画布"),
  projBtn, saveDot,
  h("div", { class: "grow" }),
  h("button", { class: "tb", title: "批量生成选中的视频节点", onclick: batchGenerate }, icon("batch", 16), h("span", {}, "批量生成")),
  h("button", { class: "tb", title: "资源库（L）", onclick: () => openLibrary() }, icon("library", 16), h("span", {}, "资源库")),
  h("button", { class: "tb icon", title: "设置", onclick: () => openSettings() }, icon("settings", 17)));

const hud = h("div", { class: "hud" },
  h("button", { title: "缩小（⌘-）", onclick: () => zoomBy(1 / 1.2) }, icon("zoomout", 15)),
  h("span", { class: "zoom-pct" }, "100%"),
  h("button", { title: "放大（⌘+）", onclick: () => zoomBy(1.2) }, icon("zoomin", 15)),
  h("span", { class: "hsep" }),
  h("button", { title: "适配视图（⌘0）", onclick: () => fitView() }, icon("fit", 15)));

const help = h("div", { class: "hint-bar" }, "双击空白处添加节点 · 拖动「+」连线 · 空格/中键拖动平移 · 滚轮缩放 · 文件直接拖进来");

const stage = h("div", { class: "stage" });
const drawerHost = h("div");
app.append(stage, topbar, hud, help, drawerHost);

initCanvas(stage, {
  nodeBody, nodeBadge, edgeRole,
  nodeError: (n) => (n.data.mode !== undefined || !(n.data.file || n.data.url)) && (n.data.prompt || state.edges.some(e => e.to === n.id)) ? nodeIssue(n) : null,
  onSelect: (ids) => showPanelFor(ids),
  onQuick: handleQuick,
  onDropFiles: dropFiles,
  onDropAsset: (id, at) => placeAsset(lib.items.find(x => x.id === id), at),
});
initPanel(app);

onChange((reason) => {
  if (reason === "view" || reason === "move") positionPanel();
  if (["add", "remove", "connect", "disconnect", "undo", "paste", "load", "inputs", "task"].includes(reason)) {
    refreshPanel();
    if (reason === "inputs" || reason === "connect" || reason === "disconnect") for (const n of state.nodes) if (n.kind === "video") rerenderNode(n.id);
  }
  if (reason === "view") hud.querySelector(".zoom-pct").textContent = Math.round(state.view.z * 100) + "%";
  if (["dirty", "saving", "saved", "load"].includes(reason)) {
    const s = state.saveState;
    saveDot.className = "save-dot " + s;
    saveDot.title = { saved: "已保存到项目文件夹", dirty: "有未保存的修改", saving: "保存中…", error: "保存失败，检查服务是否在运行" }[s];
  }
  help.style.display = state.nodes.length ? "none" : "";
});
onTask((id) => { rerenderNode(id); if (state.selection.has(id)) refreshPanel(); });

/* =========================================================
   全局能力（给节点 / 面板里的按钮用）
   ========================================================= */
window.__seedance = {
  quickStart, pickForNode, pickAndLink, linkVideoUrl, openLibrary, openSettings, focus: focusNode,
  disconnect: (id) => { disconnect(id); refreshPanel(); },
  modalJSON, prompt: promptDialog,
};

/* =========================================================
   项目
   ========================================================= */
async function boot() {
  await loadLocalDefaults();
  const info = await api("/api/project").catch(() => ({ open: false }));
  if (info.open) await enterProject(info);
  else welcome();
}

async function enterProject(info) {
  stopAllTimers();
  state.project = { name: info.name, path: info.path };
  projBtn.querySelector(".proj-name").textContent = info.name;
  projBtn.title = info.path;
  document.title = `${info.name} · Seedance 画布`;
  const doc = await api("/api/canvas").catch(() => null);
  load(doc || {});
  render();
  if (!doc || !doc.view) fitView();
  await refreshLib();
  showPanelFor([]);
  closeWelcome();
  resumeAll();
  if (!getConn().apiKey || !getConn().baseUrl) setTimeout(() => toast("还没配置网关，点右上角设置填写网关地址和 API Key", "warn", 5000), 600);
}

let welcomeEl = null;
async function welcome() {
  closeWelcome();
  const recent = await api("/api/projects/recent").catch(() => []);
  const manual = h("input", { class: "path-input", placeholder: "/Users/你/Movies/我的项目", spellcheck: "false" });
  manual.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") openPath(manual.value, true); });
  welcomeEl = h("div", { class: "welcome" },
    h("div", { class: "wcard" },
      h("div", { class: "w-logo" }, icon("play", 22)),
      h("h1", {}, "Seedance 画布"),
      h("p", { class: "w-sub" }, "一个文件夹就是一个项目：画布、上传的素材、生成的视频都存在里面。"),
      h("div", { class: "w-actions" },
        h("button", { class: "btn primary big", onclick: () => pick("new") }, icon("plus", 16), "新建项目"),
        h("button", { class: "btn big", onclick: () => pick("open") }, icon("folder", 16), "打开项目文件夹")),
      recent.length ? h("div", { class: "w-recent" }, h("div", { class: "w-h" }, "最近项目"),
        recent.map(r => h("button", { class: "w-item", disabled: !r.exists, title: r.path, onclick: () => openPath(r.path) },
          icon("folder", 15), h("span", { class: "n" }, r.name), h("span", { class: "p" }, r.exists ? r.path : "文件夹已不存在")))) : null,
      h("details", { class: "w-manual" }, h("summary", {}, "手动输入文件夹路径"),
        h("div", { class: "row" }, manual, h("button", { class: "btn", onclick: () => openPath(manual.value, true) }, "打开")),
        h("div", { class: "w-tip" }, "文件夹不存在会自动创建。只会在里面新增 canvas.json、assets.json 和 assets/，不动原有文件。"))));
  app.appendChild(welcomeEl);
}
function closeWelcome() { welcomeEl?.remove(); welcomeEl = null; }

async function pick(mode) {
  try {
    toast("请在弹出的 Finder 窗口里选择文件夹", "info", 2200);
    const r = await api("/api/project/pick", { method: "POST", body: { mode } });
    if (r.cancelled) return;
    await switchTo(r);
  } catch (e) {
    toast(e.message + " —— 可以用下面的「手动输入文件夹路径」", "err", 6000);
    if (welcomeEl) welcomeEl.querySelector(".w-manual").open = true;
    else { await welcome(); welcomeEl.querySelector(".w-manual").open = true; }
  }
}

async function openPath(p, create = false) {
  p = String(p || "").trim();
  if (!p) { toast("请输入文件夹路径", "warn"); return; }
  try { await switchTo(await api("/api/project/open", { method: "POST", body: { path: p, create } })); }
  catch (e) { toast(e.message, "err"); }
}

async function switchTo(info) {
  if (state.project) await flush();
  await enterProject(info);
  toast(`已打开项目「${info.name}」`, "ok");
}

async function projectMenu(anchor) {
  const recent = await api("/api/projects/recent").catch(() => []);
  menu(anchor, [
    ...(state.project ? [{ title: state.project.path }] : []),
    { label: "新建项目…", icon: "plus", onClick: () => pick("new") },
    { label: "打开项目文件夹…", icon: "folder", onClick: () => pick("open") },
    ...(state.project ? [{ label: "在 Finder 中显示", icon: "locate", onClick: () => reveal().catch(e => toast(e.message, "err")) }] : []),
    ...(recent.filter(r => r.path !== state.project?.path).length ? ["-", { title: "最近项目" }] : []),
    ...recent.filter(r => r.path !== state.project?.path).slice(0, 8).map(r => ({
      label: r.name, hint: r.exists ? "" : "已不存在", disabled: !r.exists, icon: "folder", tip: r.path, onClick: () => openPath(r.path),
    })),
  ]);
}

/* =========================================================
   节点快捷操作
   ========================================================= */
function nextTo(n, side = "left", idx = 0) {
  return side === "left" ? { x: n.x - 330, y: n.y + idx * 60 } : { x: n.x + n.w + 110, y: n.y + idx * 60 };
}

async function quickStart(nodeId, action) {
  const n = getNode(nodeId); if (!n) return;
  if (action === "continue") {
    const prev = addNode("video", n.x - n.w - 140, n.y);
    prev.data.params.returnLastFrame = true;
    connect(prev.id, n.id);
    select([prev.id]);
    toast("已在左侧添加上一段视频节点（已开启返回尾帧），先生成它，本节点会用它的尾帧作首帧", "info", 5000);
    return;
  }
  checkpoint();
  n.data.mode = action;
  n.data.roles = {};
  markDirty();
  select([n.id]);
  const need = action === "firstlast" ? 2 : 1;
  const files = await pickFiles("image/*", action !== "first");
  if (!files.length) { rerenderNode(n.id); refreshPanel(); return; }
  await linkFiles(n, files.slice(0, action === "ref" ? 30 : need));
}

async function linkFiles(target, files) {
  const existing = state.edges.filter(e => e.to === target.id).length;
  let i = 0;
  for (const f of files) {
    try {
      const item = await upload(f);
      const at = nextTo(target, "left", existing + i);
      const node = placeAsset(item, { x: at.x, y: at.y + i * 220 }, true);
      if (node) { const err = connect(node.id, target.id); if (err) toast(err, "warn"); }
      i++;
    } catch (e) { toast(e.message, "err"); }
  }
  select([target.id]);
}

async function pickForNode(nodeId, kind) {
  const n = getNode(nodeId); if (!n) return;
  const [f] = await pickFiles(kind === "image" ? "image/*" : kind === "audio" ? "audio/*" : "video/*", false);
  if (!f) return;
  try {
    const item = await upload(f);
    checkpoint();
    n.data.file = item.file; n.data.assetId = item.id;
    markDirty(); rerenderNode(n.id); refreshPanel();
  } catch (e) { toast(e.message, "err"); }
}

async function pickAndLink(nodeId, kind) {
  const n = getNode(nodeId); if (!n) return;
  const files = await pickFiles(kind === "image" ? "image/*" : "audio/*", true);
  if (files.length) await linkFiles(n, files);
}

async function linkVideoUrl(nodeId, at) {
  const url = await promptDialog("参考视频外链", "粘贴公网可访问的 https 视频地址（方舟只接受链接，不接受本地视频）");
  if (!url) return;
  if (!/^https?:\/\//i.test(url.trim())) { toast("需要 http(s) 开头的链接", "err"); return; }
  const target = nodeId ? getNode(nodeId) : null;
  const pos = at || (target ? nextTo(target, "left", state.edges.filter(e => e.to === target.id).length) : viewportCenter());
  const v = addNode("video", pos.x, pos.y, {}, { w: 300, h: 169, title: "参考视频" });
  delete v.data.mode; delete v.data.params; delete v.data.results; delete v.data.prompt; delete v.data.active;
  v.data.url = url.trim();
  if (target) { const err = connect(v.id, target.id); if (err) toast(err, "warn"); }
  render(); select([target?.id || v.id]);
}

/** 把资源放到画布上 */
function placeAsset(item, at, silent = false) {
  if (!item) return null;
  let n;
  if (item.kind === "image") {
    const ar = item.width && item.height ? item.height / item.width : 1;
    const w = 260, hh = Math.round(Math.min(360, Math.max(140, w * ar)));
    n = addNode("image", at.x, at.y, { file: item.file, assetId: item.id }, { w, h: hh, title: item.name?.slice(0, 20) || undefined });
  } else if (item.kind === "audio") {
    n = addNode("audio", at.x, at.y, { file: item.file, assetId: item.id }, { title: item.name?.slice(0, 20) || undefined });
  } else if (item.kind === "video") {
    n = addNode("video", at.x, at.y, {}, { w: 320, h: 180, title: item.name?.slice(0, 20) || "视频素材" });
    delete n.data.mode; delete n.data.params; delete n.data.results; delete n.data.prompt; delete n.data.active;
    n.data.file = item.file; n.data.assetId = item.id;
    // 生成的视频带云端链接，24 小时内可作参考视频
    if (item.remoteUrl) n.data.url = item.remoteUrl;
  } else return null;
  render();
  if (!silent) select([n.id]);
  return n;
}

async function dropFiles(files, at) {
  let i = 0;
  for (const f of files) {
    if (!kindOfFile(f)) { toast(`${f.name}：不支持的文件类型`, "warn"); continue; }
    try {
      const item = await upload(f);
      placeAsset(item, { x: at.x + i * 30, y: at.y + i * 30 }, i > 0);
      i++;
    } catch (e) { toast(e.message, "err"); }
  }
  if (i) toast(`已添加 ${i} 个素材，并存入资源库`, "ok");
}

async function handleQuick(kind, opts = {}) {
  const at = opts.at || viewportCenter();
  const target = opts.link ? getNode(opts.link) : null;
  if (kind === "generate") { generate(opts.id); return; }
  if (kind === "library") { openLibrary({ link: opts.link, at }); return; }
  if (kind === "pick-video") {
    if (target) { linkVideoUrl(target.id, at); return; }
    menu(null, [
      { label: "上传本地视频（仅预览 / 存档）", icon: "upload", onClick: async () => {
        const [f] = await pickFiles("video/*", false); if (!f) return;
        try { placeAsset(await upload(f), at); } catch (e) { toast(e.message, "err"); }
      } },
      { label: "粘贴公网视频链接（可作参考）", icon: "link", onClick: () => linkVideoUrl(null, at) },
    ], { at: toScreen(at.x, at.y) });
    return;
  }
  const accept = kind === "pick-image" ? "image/*" : "audio/*";
  const files = await pickFiles(accept, true);
  if (!files.length) return;
  if (target) { await linkFiles(target, files); return; }
  await dropFiles(files, at);
}

async function batchGenerate() {
  const vids = [...state.selection].map(getNode).filter(n => n?.kind === "video" && n.data.mode !== undefined);
  if (!vids.length) { toast("先框选几个视频节点", "warn"); return; }
  const ok = [], bad = [];
  for (const n of vids) { const e = isBusy(n) ? "正在生成" : nodeIssue(n, true); (e ? bad : ok).push([n, e]); }
  if (!ok.length) { toast(`没有可生成的节点：${bad[0][0].title} · ${bad[0][1]}`, "err", 5000); return; }
  if (!(await confirmDialog("批量生成", `将提交 ${ok.length} 个节点（最多同时 3 个）。` + (bad.length ? `跳过 ${bad.length} 个：${bad.map(([n, e]) => `${n.title}（${e}）`).join("、")}` : "")))) return;
  for (const [n] of ok) generate(n.id);
}

/* =========================================================
   资源库抽屉
   ========================================================= */
let drawer = null, libFilter = "all", libQuery = "", libCtx = {};
function openLibrary(ctx = {}) {
  if (!state.project) { toast("先打开一个项目", "warn"); return; }
  libCtx = ctx;
  if (drawer) { renderDrawer(); return; }
  drawer = h("div", { class: "drawer" });
  drawer.addEventListener("pointerdown", (e) => e.stopPropagation());
  drawerHost.appendChild(drawer);
  requestAnimationFrame(() => drawer.classList.add("open"));
  renderDrawer();
  refreshLib();
}
function closeDrawer() { if (!drawer) return; drawer.classList.remove("open"); const d = drawer; drawer = null; setTimeout(() => d.remove(), 200); }
onLibChange(() => { if (drawer) renderDrawer(); });

function renderDrawer() {
  if (!drawer) return;
  const q = libQuery.trim().toLowerCase();
  const items = lib.items.filter(it => (libFilter === "all" || it.kind === libFilter)
    && (!q || (it.name || "").toLowerCase().includes(q) || (it.meta?.prompt || "").toLowerCase().includes(q)));
  const counts = { all: lib.items.length, image: 0, video: 0, audio: 0 };
  for (const it of lib.items) if (counts[it.kind] !== undefined) counts[it.kind]++;
  const search = h("input", { class: "lib-search", placeholder: "搜索名称或提示词", value: libQuery });
  search.addEventListener("input", () => { libQuery = search.value; renderDrawer(); setTimeout(() => { const s = drawer?.querySelector(".lib-search"); s?.focus(); s?.setSelectionRange(s.value.length, s.value.length); }); });
  search.addEventListener("keydown", (e) => e.stopPropagation());
  const target = libCtx.link ? getNode(libCtx.link) : null;

  fill(drawer,
    h("div", { class: "dr-head" },
      h("b", {}, "资源库"), h("span", { class: "dr-sub", title: state.project.path }, state.project.name + " / assets"),
      h("div", { class: "grow" }),
      h("button", { class: "icon-btn", title: "在 Finder 中显示", onclick: () => reveal().catch(e => toast(e.message, "err")) }, icon("folder", 16)),
      h("button", { class: "icon-btn", title: "刷新", onclick: () => refreshLib() }, icon("refresh", 16)),
      h("button", { class: "icon-btn", title: "关闭", onclick: closeDrawer }, icon("close", 16))),
    target ? h("div", { class: "dr-ctx" }, "点击素材，连接到「", h("b", {}, target.title), "」",
      h("button", { onclick: () => { libCtx = {}; renderDrawer(); } }, "取消")) : null,
    h("div", { class: "dr-tools" },
      h("div", { class: "dr-tabs" }, [["all", "全部"], ["image", "图片"], ["video", "视频"], ["audio", "音频"]].map(([k, t]) =>
        h("button", { class: libFilter === k ? "on" : "", onclick: () => { libFilter = k; renderDrawer(); } }, t, h("em", {}, counts[k])))),
      h("div", { class: "row" }, search,
        h("button", { class: "btn", onclick: async () => {
          const files = await pickFiles("image/*,video/*,audio/*", true);
          for (const f of files) { try { await upload(f); } catch (e) { toast(e.message, "err"); } }
        } }, icon("upload", 14), "上传"))),
    items.length ? h("div", { class: "lib-grid scroll" }, items.map(it => libCard(it, target)))
      : h("div", { class: "lib-empty" }, lib.items.length ? "没有匹配的素材" : "还没有素材。上传、拖进画布，或生成的视频都会出现在这里。"));
}

function libCard(it, target) {
  const src = fileUrl(it.file);
  const thumb = it.kind === "image" ? h("img", { src, loading: "lazy", draggable: "false" })
    : it.kind === "video" ? h("video", { src, muted: true, preload: "metadata", playsinline: true })
    : h("div", { class: "aud" }, icon("audio", 28));
  if (it.kind === "video") {
    thumb.addEventListener("mouseenter", () => thumb.play().catch(() => {}));
    thumb.addEventListener("mouseleave", () => { thumb.pause(); thumb.currentTime = 0; });
  }
  const card = h("div", { class: "lib-card", draggable: "true", title: it.meta?.prompt || it.name },
    h("div", { class: "lc-thumb" }, thumb,
      it.source === "generated" ? h("span", { class: "lc-tag" }, "生成") : null,
      it.duration || it.meta?.duration ? h("span", { class: "lc-dur" }, `${Math.round(it.duration || it.meta.duration)}s`) : null),
    h("div", { class: "lc-meta" }, h("div", { class: "lc-name" }, it.name),
      h("div", { class: "lc-sub" }, [fmtTime(it.createdAt), fmtBytes(it.size), it.meta?.cost != null ? fmtYuan(it.meta.cost) : null].filter(Boolean).join(" · "))));
  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("application/x-seedance-asset", it.id);
    e.dataTransfer.effectAllowed = "copy";
  });
  card.addEventListener("click", () => {
    if (target) {
      if (it.kind === "video" && !it.remoteUrl) { toast("本地视频不能作参考视频（方舟只收公网链接）", "warn"); return; }
      const at = nextTo(target, "left", state.edges.filter(e => e.to === target.id).length);
      const n = placeAsset(it, at, true);
      if (n) { const err = connect(n.id, target.id); if (err) toast(err, "warn"); else toast(`已连接到「${target.title}」`, "ok", 1400); }
      select([target.id]);
      return;
    }
    assetDetail(it);
  });
  card.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); assetMenu(it, { x: e.clientX, y: e.clientY }); });
  return card;
}

function assetMenu(it, at) {
  const usedBy = state.nodes.filter(n => n.data?.assetId === it.id || n.data?.results?.some(r => r.assetId === it.id || r.lastFrameAssetId === it.id));
  menu(null, [
    { label: "放到画布中央", icon: "plus", onClick: () => { const c = viewportCenter(); placeAsset(it, { x: c.x - 130, y: c.y - 100 }); } },
    ...(usedBy.length ? [{ label: "在画布上定位", icon: "locate", onClick: () => { focusNode(usedBy[0].id); } }] : []),
    { label: "下载", icon: "download", onClick: () => { const a = h("a", { href: fileUrl(it.file) + "?download", download: it.file }); a.click(); } },
    { label: "在 Finder 中显示", icon: "folder", onClick: () => reveal(it.file).catch(e => toast(e.message, "err")) },
    { label: "重命名", onClick: async () => { const v = await promptDialog("重命名", "", it.name); if (v) renameAsset(it.id, v); } },
    "-",
    { label: "删除文件", icon: "trash", danger: true, onClick: () => deleteAsset(it, usedBy) },
  ], { at });
}

async function deleteAsset(it, usedBy) {
  const warn = usedBy.length ? `画布上有 ${usedBy.length} 个节点在用它，删除后这些节点会显示为空。` : "";
  if (!(await confirmDialog("删除素材", `「${it.name}」会从项目文件夹的 assets/ 里永久删除。${warn}`, { ok: "删除", danger: true }))) return;
  try { await removeAsset(it.id); toast("已删除", "ok"); } catch (e) { toast(e.message, "err"); }
}

function assetDetail(it) {
  const src = fileUrl(it.file);
  const m = it.meta || {};
  const row = (k, v) => v === undefined || v === null || v === "" ? null : h("div", { class: "kv-row" }, h("span", {}, k), h("b", {}, String(v)));
  modal((close) => h("div", { class: "detail" },
    h("div", { class: "det-media" },
      it.kind === "image" ? h("img", { src }) : it.kind === "video" ? h("video", { src, controls: true, autoplay: true, loop: true }) : h("audio", { src, controls: true })),
    h("div", { class: "det-side scroll" },
      h("div", { class: "det-title" }, it.name),
      m.prompt ? h("div", { class: "det-prompt" }, m.prompt) : null,
      h("div", { class: "kv-list" },
        row("来源", it.source === "generated" ? "生成" : "上传"), row("时间", fmtTime(it.createdAt)), row("文件", it.file),
        row("大小", fmtBytes(it.size)), row("尺寸", it.width ? `${it.width}×${it.height}` : null),
        row("时长", m.duration || it.duration ? `${m.duration || it.duration}s` : null),
        row("分辨率", m.resolution || m.params?.resolution), row("模型", m.params?.model),
        row("tokens", m.tokens?.toLocaleString?.()), row("费用", m.cost != null ? fmtYuan(m.cost) : null),
        row("任务 ID", m.taskId)),
      h("div", { class: "det-actions" },
        m.taskId ? h("button", { class: "btn", onclick: () => copyText(m.taskId, "任务 ID 已复制") }, icon("copy", 14), "复制任务 ID") : null,
        h("button", { class: "btn", onclick: () => { close(); const c = viewportCenter(); placeAsset(it, { x: c.x - 130, y: c.y - 100 }); } }, icon("plus", 14), "放到画布"),
        h("button", { class: "btn", onclick: () => reveal(it.file).catch(e => toast(e.message, "err")) }, icon("folder", 14), "在 Finder 中显示"),
        h("button", { class: "btn danger", onclick: async () => { close(); const usedBy = state.nodes.filter(n => n.data?.assetId === it.id); await deleteAsset(it, usedBy); } }, icon("trash", 14), "删除")))
  ), { width: 880 });
}

/* =========================================================
   设置
   ========================================================= */
function openSettings() {
  const c = getConn();
  const field = (label, key, attrs = {}, tip) => {
    const input = h("input", { value: c[key] ?? "", spellcheck: "false", ...attrs });
    input.addEventListener("keydown", (e) => e.stopPropagation());
    input.dataset.key = key;
    return h("label", { class: "set-row" }, h("span", {}, label, tip ? h("em", {}, tip) : null), input);
  };
  modal((close) => {
    const keyField = field("API Key", "apiKey", { type: "password", placeholder: "sk-…" }, "只存在本机浏览器里");
    const reveal_ = h("button", { class: "chip", type: "button", onclick: () => { const i = keyField.querySelector("input"); i.type = i.type === "password" ? "text" : "password"; } }, "显示");
    keyField.appendChild(reveal_);
    const status = h("div", { class: "set-status" });
    const form = h("div", { class: "settings" },
      h("div", { class: "dlg-title" }, "设置"),
      field("网关地址", "baseUrl", { placeholder: "https://your-gateway.example.com" }, "New API"),
      keyField,
      field("对话模型", "chatModel", { placeholder: "claude-sonnet-5" }, "润色 / 翻译用"),
      h("details", { class: "set-adv" }, h("summary", {}, "接口路径（一般不用改）"),
        field("提交路径", "createPath"), field("查询路径", "fetchPath")),
      status,
      h("div", { class: "dlg-actions" },
        h("div", { class: "grow" }),
        h("button", { class: "btn", onclick: async () => {
          save(); status.textContent = "测试中…"; status.className = "set-status";
          const cc = getConn();
          try {
            const r = await fetch(cc.baseUrl.replace(/\/+$/, "") + cc.fetchPath + "/probe-not-a-real-task", { headers: { Authorization: "Bearer " + cc.apiKey } });
            const t = await r.text();
            if (r.status === 401 || r.status === 403) { status.textContent = `网关可达，但 Key 被拒（HTTP ${r.status}）`; status.className = "set-status err"; }
            else { status.textContent = `网关可达，Key 有效（HTTP ${r.status}）`; status.className = "set-status ok"; }
          } catch (e) { status.textContent = "连不上网关：" + e.message; status.className = "set-status err"; }
        } }, "测试连接"),
        h("button", { class: "btn primary", onclick: () => { save(); close(); toast("已保存", "ok", 1200); refreshPanel(); } }, "保存")));
    const save = () => {
      const next = {};
      for (const i of form.querySelectorAll("input[data-key]")) next[i.dataset.key] = i.value.trim();
      setConn(next);
    };
    return form;
  }, { width: 520 });
}

/* =========================================================
   小对话框
   ========================================================= */
function promptDialog(title, text, value = "") {
  return new Promise((resolve) => {
    let done = false;
    const input = h("input", { class: "path-input", value, spellcheck: "false" });
    const close = modal((close) => {
      const ok = () => { done = true; close(); resolve(input.value.trim() || null); };
      input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") ok(); });
      return h("div", { class: "dlg" }, h("div", { class: "dlg-title" }, title), text ? h("div", { class: "dlg-text" }, text) : null, input,
        h("div", { class: "dlg-actions" },
          h("button", { class: "btn", onclick: () => { done = true; close(); resolve(null); } }, "取消"),
          h("button", { class: "btn primary", onclick: ok }, "确定")));
    }, { width: 460, onClose: () => { if (!done) resolve(null); } });
    setTimeout(() => input.focus());
  });
}

function modalJSON(title, obj) {
  modal((close) => h("div", { class: "dlg" }, h("div", { class: "dlg-title" }, title),
    h("pre", { class: "code scroll" }, JSON.stringify(obj, null, 2)),
    h("div", { class: "dlg-actions" },
      h("button", { class: "btn", onclick: () => copyText(JSON.stringify(obj, null, 2)) }, "复制"),
      h("button", { class: "btn primary", onclick: close }, "关闭"))), { width: 720 });
}

/* ---------- 快捷键：L 资源库 ---------- */
window.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, [contenteditable]") || document.querySelector(".modal-back")) return;
  if (e.key.toLowerCase() === "l" && !e.metaKey && !e.ctrlKey) { drawer ? closeDrawer() : openLibrary(); }
});

boot();
