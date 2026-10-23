/* =========================================================================
   节点内容渲染 + 生成器面板（选中视频节点时浮在其下方）
   ========================================================================= */
import { state, getNode, inputsOf, markDirty, checkpoint, endGesture, addNode, connect, emit } from "./store.js";
import { h, fill, icon, menu, popover, toast, copyText, fileUrl, fmtYuan, fmtClock, closePopover } from "./ui.js";
import { MODELS, RATIOS, modelByFamily, ROLE_LABEL, chat } from "../lib/seedance.js";
import {
  collectInputs, composePrompt, nodeIssue, nodeEstimate, generate, stopTask, resumeTask, retryDownload, getConn, isBusy,
} from "./generator.js";
import { toScreen, rerenderNode, select, nodeElement } from "./canvas.js";

const MODE_LABEL = { t2v: "文生视频", first: "首帧生成", firstlast: "首尾帧生成", ref: "参考生视频" };
const MODE_ICON  = { t2v: "text", first: "sparkle", firstlast: "layers", ref: "image" };

export const CAMERA_PRESETS = [
  ["推镜", "镜头缓慢向前推近主体"], ["拉镜", "镜头缓慢向后拉远，展现环境"], ["左摇", "镜头水平向左摇"],
  ["右摇", "镜头水平向右摇"], ["上升", "镜头缓缓升起，俯瞰全景"], ["环绕", "镜头围绕主体 360 度环绕"],
  ["跟拍", "镜头跟随主体移动"], ["手持", "手持镜头，轻微晃动，纪实感"], ["固定机位", "固定机位，画面稳定"],
  ["低角度仰拍", "低角度仰拍，主体显得高大"], ["特写", "面部特写，浅景深"], ["航拍", "无人机航拍视角"],
];
export const FX_PRESETS = [
  ["电影感", "电影级画质，35mm 胶片质感，浅景深"], ["黄金时刻", "黄金时刻暖色逆光，柔和光晕"],
  ["赛博朋克", "霓虹灯光，赛博朋克风格，雨夜反光"], ["水墨", "中国水墨画风格，留白意境"],
  ["动漫", "日系动漫风格，赛璐璐上色"], ["慢动作", "慢动作，高帧率质感"], ["雾气", "空气中弥漫薄雾，丁达尔光"],
  ["夜景", "夜晚，城市灯光，低照度"], ["复古", "复古 80 年代色调，颗粒感"], ["写实", "超写实，细节丰富，自然光"],
];

/* =========================================================
   节点内容
   ========================================================= */
export function nodeBody(n) {
  if (n.kind === "text") return textBody(n);
  if (n.kind === "image") return mediaBody(n, "image");
  if (n.kind === "audio") return mediaBody(n, "audio");
  if (n.kind === "video") return n.data.mode === undefined && (n.data.file || n.data.url) ? mediaBody(n, "video") : videoBody(n);
  return h("div");
}

function textBody(n) {
  const empty = !String(n.data.text || "").trim();
  const ta = h("textarea", {
    class: "text-edit no-drag scroll", placeholder: "写提示词、旁白或设定…\n连到视频节点后会拼进提示词",
    spellcheck: "false",
  });
  ta.value = n.data.text || "";
  let started = false;
  ta.addEventListener("input", () => {
    if (!started) { checkpoint("text-" + n.id); started = true; }
    n.data.text = ta.value;
    markDirty();
    for (const e of state.edges) if (e.from === n.id) emit("inputs");
  });
  ta.addEventListener("blur", () => { started = false; endGesture(); });
  ta.addEventListener("keydown", (e) => e.stopPropagation());
  return h("div", { class: "body-text" + (empty ? " empty" : "") },
    empty ? h("div", { class: "placeholder-ic" }, icon("text", 56)) : null, ta);
}

function mediaBody(n, kind) {
  const src = n.data.file ? fileUrl(n.data.file) : n.data.url;
  if (!src) {
    return h("div", { class: "body-empty" }, icon(kind === "image" ? "image" : kind === "audio" ? "audio" : "video", 48),
      h("button", { class: "chip no-drag", onclick: () => window.__seedance.pickForNode(n.id, kind) }, icon("upload", 14), "上传"));
  }
  if (kind === "image") return h("div", { class: "body-media" }, h("img", { src, draggable: "false", alt: n.title }));
  if (kind === "audio") return h("div", { class: "body-audio" }, icon("audio", 28),
    h("audio", { src, controls: true, preload: "metadata", class: "no-drag" }));
  return h("div", { class: "body-media" }, h("video", { src, controls: true, preload: "metadata", playsinline: true, class: "no-drag" }),
    !/^https?:/i.test(n.data.url || "") ? h("div", { class: "media-note" }, "本地视频 · 不能作参考（方舟只收公网链接）") : null);
}

function videoBody(n) {
  const results = n.data.results || [];
  const task = n.data.task;
  if (task) return runningBody(n, task);

  if (results.length) {
    const i = Math.min(n.data.active || 0, results.length - 1);
    const r = results[i];
    const src = r.file ? fileUrl(r.file) : r.remoteUrl;
    const kids = [h("video", { src, controls: true, loop: true, preload: "metadata", playsinline: true, class: "no-drag" })];
    if (results.length > 1) {
      kids.push(h("div", { class: "pager no-drag" },
        h("button", { onclick: () => { n.data.active = (i - 1 + results.length) % results.length; markDirty(); rerenderNode(n.id); } }, icon("left", 14)),
        h("span", {}, `${i + 1} / ${results.length}`),
        h("button", { onclick: () => { n.data.active = (i + 1) % results.length; markDirty(); rerenderNode(n.id); } }, icon("right", 14))));
    }
    if (!r.file) kids.push(h("div", { class: "media-note warn no-drag" }, "未保存到项目 · ",
      h("a", { href: "#", onclick: (e) => { e.preventDefault(); retryDownload(n.id, i); } }, "重试保存")));
    if (n.data.lastError) kids.push(errorStrip(n));
    return h("div", { class: "body-media" }, kids);
  }

  // 空状态：截图里的「尝试：」快捷入口
  return h("div", { class: "body-video-empty" },
    h("div", { class: "big-play" }, icon("play", 54)),
    n.data.lastError ? errorStrip(n) : h("div", { class: "try" },
      h("div", { class: "try-h" }, "尝试："),
      tryItem(n, "sparkle", "首帧生成视频", "first"),
      tryItem(n, "layers", "首尾帧生成视频", "firstlast"),
      tryItem(n, "image", "参考图 / 视频生成", "ref"),
      tryItem(n, "continue", "续写上一段视频", "continue")));
}

function tryItem(n, ic, label, action) {
  return h("button", { class: "try-item no-drag", onclick: (e) => { e.stopPropagation(); window.__seedance.quickStart(n.id, action); } },
    icon(ic, 14), label);
}

function errorStrip(n) {
  const err = n.data.lastError;
  return h("div", { class: "err-strip no-drag" },
    icon("warn", 14), h("span", { class: "msg", title: err.message }, err.message),
    err.taskId ? h("button", { onclick: () => copyText(err.taskId, "任务 ID 已复制") }, "复制 ID") : null,
    err.raw ? h("button", { onclick: () => showRaw(err) }, "原始响应") : null,
    h("button", { onclick: () => { n.data.lastError = null; markDirty(); rerenderNode(n.id); } }, icon("close", 12)));
}

function showRaw(err) {
  window.__seedance.modalJSON("原始响应", { task_id: err.taskId, message: err.message, body: err.raw });
}

function runningBody(n, task) {
  const el = Math.round((Date.now() - (task.startedAt || Date.now())) / 1000);
  const jobs = task.jobs || [];
  const row = (j) => h("div", { class: "job" },
    h("span", { class: "dot " + (j.phase === "run" ? "run" : j.phase === "ok" ? "ok" : "err") }),
    h("span", { class: "job-st" }, j.phase === "run" ? `${j.status || "排队中"}${j.progress ? " · " + j.progress : ""}` :
      j.phase === "ok" ? "完成" : (j.error || "失败")),
    j.id ? h("button", { class: "job-id no-drag", title: "复制任务 ID：" + j.id, onclick: () => copyText(j.id, "任务 ID 已复制") },
      String(j.id).slice(0, 14) + "…", icon("copy", 11)) : null);
  return h("div", { class: "body-running" },
    h("div", { class: "spinner" }),
    h("div", { class: "run-time", dataset: { since: task.startedAt } }, fmtClock(el)),
    h("div", { class: "run-st" }, task.status || "生成中"),
    jobs.length ? h("div", { class: "jobs" }, jobs.map(row)) : null,
    h("button", { class: "chip ghost no-drag", title: "只停止本页查询；服务端任务会继续跑并计费",
                  onclick: () => stopTask(n.id) }, "停止查询"));
}

/** 节点右上角徽标 */
export function nodeBadge(n) {
  if (n.kind !== "video") return [];
  const out = [];
  if (n.data.task) out.push(h("span", { class: "b run" }, "生成中"));
  const r = n.data.results?.[n.data.active || 0];
  if (r && !n.data.task) {
    if (r.check) out.push(h("span", { class: "b " + (r.check.ok ? "ok" : "warn"), title: r.check.text }, r.check.ok ? `${r.duration}s ✓` : `${r.duration}s ≠ ${r.request?.duration}s`));
    if (r.cost != null) out.push(h("span", { class: "b", title: `${r.tokens?.toLocaleString?.() || "—"} tokens` }, fmtYuan(r.cost)));
  }
  return out;
}

/** 连线标签：图片 → 视频时显示角色 */
export function edgeRole(e) {
  const to = getNode(e.to);
  if (!to || to.kind !== "video") return null;
  const from = getNode(e.from);
  if (!from || from.kind === "text") return null;
  const { media } = collectInputs(to);
  const m = media.find(x => x.nodeId === from.id);
  return m ? ROLE_LABEL[m.role] : null;
}

/* =========================================================
   生成器面板
   ========================================================= */
let panel = null, panelNode = null, expanded = false;

export function initPanel(host) {
  panel = h("div", { class: "gen hidden" });
  host.appendChild(panel);
  panel.addEventListener("pointerdown", (e) => e.stopPropagation());
  panel.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  setInterval(tickRunning, 1000);
}

function tickRunning() {
  for (const el of document.querySelectorAll(".run-time[data-since]")) {
    el.textContent = fmtClock((Date.now() - Number(el.dataset.since)) / 1000);
  }
}

export function showPanelFor(ids) {
  const n = ids.length === 1 ? getNode(ids[0]) : null;
  if (!n || n.kind !== "video" || (n.data.mode === undefined && (n.data.file || n.data.url))) {
    panel.classList.add("hidden"); panelNode = null; return;
  }
  if (panelNode !== n.id) expanded = false;
  panelNode = n.id;
  renderPanel();
  panel.classList.remove("hidden");
  positionPanel();
}

export function refreshPanel() { if (panelNode) { if (!getNode(panelNode)) { panel.classList.add("hidden"); panelNode = null; return; } renderPanel(); positionPanel(); } }

export function positionPanel() {
  if (!panelNode || panel.classList.contains("hidden")) return;
  const n = getNode(panelNode); if (!n) return;
  const a = toScreen(n.x, n.y + n.h + 30);
  const z = state.view.z;
  const width = Math.max(560, Math.min(760, n.w * z + 220));
  const cx = toScreen(n.x + n.w / 2, 0).x;
  let left = cx - width / 2;
  left = Math.max(12, Math.min(left, innerWidth - width - 12));
  let top = a.y + 26;
  const ph = panel.offsetHeight || 220;
  // 别压住左下角的缩放控件
  const hudTop = innerHeight - 64;
  if (top + ph > innerHeight - 12) top = Math.max(64, innerHeight - ph - 12);
  if (left < 190 && top + ph > hudTop) top = Math.max(64, hudTop - ph - 8);
  panel.style.width = width + "px";
  panel.style.left = left + "px";
  panel.style.top = top + "px";
}

function renderPanel() {
  const n = getNode(panelNode);
  if (!n) return;
  const p = n.data.params;
  const { texts, media, issues } = collectInputs(n);
  const issue = nodeIssue(n, true);
  const est = nodeEstimate(n);
  const busy = isBusy(n);
  const fam = modelByFamily(p.family);

  // 已连接素材条
  const strip = h("div", { class: "gen-inputs" },
    texts.map((t) => h("span", { class: "in-chip text", title: t.text }, icon("text", 12), t.title)),
    media.map((m, i) => inputChip(n, m, i)));

  const ta = h("textarea", {
    class: "gen-prompt scroll", rows: expanded ? 10 : 3, spellcheck: "false",
    placeholder: texts.length ? "补充描述（连进来的文本会拼在前面）。@引用素材" : "描述你想要生成的画面内容，@引用素材",
  });
  ta.value = n.data.prompt || "";
  let started = false;
  ta.addEventListener("input", () => {
    if (!started) { checkpoint("prompt-" + n.id); started = true; }
    n.data.prompt = ta.value;
    markDirty();
    updateFoot();
    if (ta.value.slice(ta.selectionStart - 1, ta.selectionStart) === "@") mentionMenu(ta, n, media);
  });
  ta.addEventListener("blur", () => { started = false; endGesture(); });
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
  });

  const submit = () => {
    const err = nodeIssue(n, true);
    if (err) { toast(err, "err"); if (/API Key|网关/.test(err)) window.__seedance.openSettings(); return; }
    generate(n.id);
  };

  const chips = h("div", { class: "gen-chips" },
    h("button", { class: "chip", onclick: (e) => addRefMenu(e.currentTarget, n) }, icon("plus", 14), "参考"),
    h("button", { class: "chip", onclick: (e) => presetMenu(e.currentTarget, ta, n, CAMERA_PRESETS) }, icon("movie", 14), "运镜"),
    h("button", { class: "chip", onclick: (e) => presetMenu(e.currentTarget, ta, n, FX_PRESETS) }, icon("camera", 14), "特效"),
    h("button", { class: "chip", onclick: () => window.__seedance.openLibrary({ link: n.id }) }, icon("library", 14), "资源库"),
    h("div", { class: "grow" }),
    h("button", { class: "icon-btn", title: expanded ? "收起" : "展开编辑", onclick: () => { expanded = !expanded; renderPanel(); positionPanel(); } },
      icon(expanded ? "collapse" : "expand", 16)));

  const modelBtn = h("button", { class: "sel", onclick: (e) => menu(e.currentTarget, MODELS.map(m => ({
      label: m.label, hint: m.family === "2.5" ? "最长 30s" : "支持 4K · 更便宜", active: m.family === p.family,
      onClick: () => setParam(n, (pp) => {
        pp.family = m.family; pp.modelId = m.id;
        if (!m.resolutions.includes(pp.resolution)) pp.resolution = m.resolutions[m.resolutions.length - 1];
        if (pp.duration > m.maxDuration) pp.duration = m.maxDuration;
      }) })), { place: "top" }) },
    icon("sliders", 14), h("b", {}, p.family), icon("chevron", 12));

  const modeBtn = h("button", { class: "sel", onclick: (e) => menu(e.currentTarget, Object.entries(MODE_LABEL).map(([k, v]) => ({
      label: v, icon: MODE_ICON[k], active: (n.data.mode || "t2v") === k,
      hint: k === "first" ? "第 1 张图作首帧" : k === "firstlast" ? "第 1、2 张作首尾帧" : k === "ref" ? "图片都作参考" : "",
      onClick: () => { checkpoint(); n.data.mode = k; n.data.roles = {}; markDirty(); rerenderNode(n.id); renderPanel(); },
    })), { place: "top" }) },
    icon(MODE_ICON[n.data.mode || "t2v"], 14), MODE_LABEL[n.data.mode || "t2v"], icon("chevron", 12));

  const paramBtn = h("button", { class: "sel params", onclick: (e) => paramsPopover(e.currentTarget, n) },
    h("span", { class: "ratio-ic", style: ratioIconStyle(p.ratio) }),
    `${p.ratio === "adaptive" ? "自适应" : p.ratio} · ${p.resolution.toUpperCase()} · ${Number(p.duration) === -1 ? "自动" : p.duration + "s"} · ${p.count || 1}个 · `,
    icon(p.generateAudio ? "volume" : "mute", 14), icon("chevron", 12));

  const cost = h("span", { class: "cost", title: "" });
  const go = h("button", { class: "go", onclick: submit }, icon("up", 18));

  function updateFoot() {
    const iss = nodeIssue(n, true);
    const e2 = nodeEstimate(n);
    cost.textContent = (e2.auto ? "≈" : "") + fmtYuan(e2.total);
    cost.title = `${e2.w}×${e2.h} · ${e2.sec}s${e2.auto ? "（自动时长按 5s 估）" : ""} · ≈${e2.tokens.toLocaleString()} tokens × ${e2.coef} / 百万` +
                 (e2.count > 1 ? ` × ${e2.count} 个` : "");
    go.disabled = busy || !!iss;
    go.title = busy ? "生成中" : iss || "生成（⌘Enter）";
    warn.textContent = iss && !/API Key|网关/.test(iss) ? iss : "";
    warn.style.display = warn.textContent ? "" : "none";
  }

  const warn = h("div", { class: "gen-warn" });
  const foot = h("div", { class: "gen-foot" },
    modelBtn, modeBtn, h("span", { class: "vsep" }), paramBtn,
    h("div", { class: "grow" }),
    h("button", { class: "icon-btn", title: "润色提示词（调用对话模型）", onclick: (e) => aiRewrite(e.currentTarget, n, ta, "polish") }, icon("polish", 18)),
    h("button", { class: "icon-btn", title: "中英互译", onclick: (e) => aiRewrite(e.currentTarget, n, ta, "translate") }, icon("translate", 18)),
    h("button", { class: "icon-btn", title: "高级设置", onclick: (e) => advancedPopover(e.currentTarget, n) }, icon("settings", 18)),
    cost, go);

  fill(panel, chips, (texts.length || media.length) ? strip : null, ta, warn, foot);
  panel.classList.toggle("expanded", expanded);
  updateFoot();
  if (issues.length) { warn.textContent = issues[0]; warn.style.display = ""; }
}

function ratioIconStyle(r) {
  const m = /^(\d+):(\d+)$/.exec(r);
  if (!m) return { width: "14px", height: "10px", borderStyle: "dashed" };
  const a = +m[1] / +m[2];
  return a >= 1 ? { width: "16px", height: Math.max(6, Math.round(16 / a)) + "px" } : { width: Math.max(6, Math.round(14 * a)) + "px", height: "14px" };
}

function inputChip(n, m, i) {
  const src = m.file ? fileUrl(m.file) : m.url;
  const label = m.kind === "image" ? `图${i + 1}` : m.kind === "video" ? "视频" : "音频";
  const chip = h("button", { class: "in-chip media", title: `${m.title} · 点击修改用途` },
    m.kind === "image" && src ? h("img", { src, alt: "" }) : icon(m.kind === "video" ? "video" : "audio", 12),
    h("span", {}, label), h("em", { class: "role-" + m.role }, ROLE_LABEL[m.role]));
  chip.addEventListener("click", () => {
    const opts = m.kind === "image" ? ["first_frame", "last_frame", "reference_image"]
      : getNode(m.nodeId)?.kind === "video" && getNode(m.nodeId)?.data.mode !== undefined ? ["first_frame", "reference_video"]
      : [m.role];
    menu(chip, [
      { title: "这张素材用作" },
      ...opts.map(r => ({ label: ROLE_LABEL[r], active: r === m.role, onClick: () => {
        checkpoint(); n.data.roles = { ...(n.data.roles || {}), [m.nodeId]: r }; markDirty(); rerenderNode(n.id); renderPanel();
      } })),
      "-",
      { label: "在画布上定位", icon: "locate", onClick: () => window.__seedance.focus(m.nodeId) },
      { label: "断开连接", icon: "close", danger: true, onClick: () => {
        const e = state.edges.find(x => x.from === m.nodeId && x.to === n.id);
        if (e) { window.__seedance.disconnect(e.id); }
      } },
    ], { place: "top" });
  });
  return chip;
}

function setParam(n, fn) {
  checkpoint();
  fn(n.data.params);
  markDirty();
  rerenderNode(n.id);
  renderPanel();
}

function seg(label, options, cur, onPick) {
  return h("div", { class: "pp-row" }, h("div", { class: "pp-l" }, label),
    h("div", { class: "pp-seg" }, options.map(([v, t, dis, tip]) =>
      h("button", { class: v === cur ? "on" : "", disabled: dis, title: tip, onclick: () => onPick(v) }, t))));
}

function paramsPopover(anchor, n) {
  const build = (close) => {
    const p = n.data.params, fam = modelByFamily(p.family);
    const redraw = () => { close(); paramsPopover(anchor, n); };
    const pick = (fn) => { setParam(n, fn); redraw(); };
    const durs = [4, 5, 6, 8, 10, 12, 15, 20, 25, 30].filter(d => d <= fam.maxDuration);
    return h("div", { class: "pp" },
      seg("比例", RATIOS.map(r => [r, r === "adaptive" ? "自适应" : r]), p.ratio, (v) => pick(pp => pp.ratio = v)),
      seg("分辨率", ["480p", "720p", "1080p", "4k"].map(r => [r, r.toUpperCase(), !fam.resolutions.includes(r),
        !fam.resolutions.includes(r) ? `Seedance ${p.family} 不支持` : ""]), p.resolution, (v) => pick(pp => pp.resolution = v)),
      // 滑块拖动时不能重建弹窗，否则每动一格就被打断
      durationSlider(p, fam, (v) => setParam(n, pp => pp.duration = v)),
      seg("个数", [1, 2, 3, 4].map(c => [c, c + "个"]), Number(p.count || 1), (v) => pick(pp => pp.count = v)),
      seg("声音", [[true, "生成音频"], [false, "静音"]], !!p.generateAudio, (v) => pick(pp => pp.generateAudio = v)),
      h("div", { class: "pp-note" }, `Seedance ${p.family}：时长 4–${fam.maxDuration}s，分辨率 ${fam.resolutions.join(" / ").toUpperCase()}。`));
  };
  popover(anchor, build, { place: "top", class: "pp-pop" });
}

function durationSlider(params, fam, onChange) {
  const min = 4, max = fam.maxDuration;
  const cur = Math.max(min, Math.min(max, Number(params.duration)));
  const label = h("span", { class: "dur-val" }, cur + "s");
  const slider = h("input", {
    type: "range", min, max, value: cur, step: 1, class: "no-drag dur-slider",
    "aria-label": "视频时长（秒）",
  });
  // 跟着滑块走的数值气泡：普通元素，不依赖浏览器对 thumb 伪元素的支持
  const bubble = h("span", { class: "dur-bubble" }, cur + "s");
  const paint = (v) => {
    const pct = (v - min) / (max - min) * 100;
    slider.style.setProperty("--fill", pct + "%");
    // 圆点宽 16px，按比例补偿，让气泡正对圆点中心
    bubble.style.left = `calc(${pct}% + ${8 - pct * 0.16}px)`;
    bubble.textContent = v + "s";
  };
  paint(cur);
  slider.addEventListener("input", () => {
    const v = +slider.value;
    label.textContent = v + "s";
    paint(v);
    onChange(v);
  });
  return h("div", { class: "pp-row pp-slider" },
    h("div", { class: "pp-l" }, "时长", label),
    h("div", { class: "pp-r" },
      h("span", { class: "dur-edge" }, min + "s"),
      h("div", { class: "dur-track" }, slider, bubble),
      h("span", { class: "dur-edge" }, max + "s")));
}

function advancedPopover(anchor, n) {
  popover(anchor, (close) => {
    const p = n.data.params;
    const toggleRow = (key, label, tip) => {
      const b = h("button", { class: "tg" + (p[key] ? " on" : ""), onclick: () => { setParam(n, pp => pp[key] = !pp[key]); b.classList.toggle("on"); } }, h("i"));
      return h("div", { class: "adv-row" }, h("div", {}, h("b", {}, label), h("span", {}, tip)), b);
    };
    const seed = h("input", { type: "number", value: p.seed, step: 1, class: "no-drag" });
    seed.addEventListener("change", () => setParam(n, pp => pp.seed = Number.isFinite(+seed.value) ? Math.trunc(+seed.value) : -1));
    seed.addEventListener("keydown", (e) => e.stopPropagation());
    return h("div", { class: "adv" },
      toggleRow("returnLastFrame", "返回尾帧", "用于续写下一段；连到下一个视频节点就当首帧"),
      toggleRow("cameraFixed", "固定镜头", "锁定机位；参考图场景下可能被忽略"),
      toggleRow("watermark", "AI 水印", "右下角显示「AI 生成」"),
      h("div", { class: "adv-row" }, h("div", {}, h("b", {}, "随机种子"), h("span", {}, "-1 为随机；固定数值可复现")),
        h("div", { class: "seed" }, seed,
          h("button", { class: "chip", onclick: () => { seed.value = Math.floor(Math.random() * 2147483647); seed.dispatchEvent(new Event("change")); } }, "随机"),
          h("button", { class: "chip", onclick: () => { seed.value = -1; seed.dispatchEvent(new Event("change")); } }, "-1"))),
      seg("任务超时", [[3600, "1 小时"], [10800, "3 小时"], [43200, "6 小时"]], Number(p.expiresAfter), (v) => setParam(n, pp => pp.expiresAfter = v)),
      h("div", { class: "adv-row" }, h("div", {}, h("b", {}, "按任务 ID 续查"), h("span", {}, "刷新或中断后接着查，不重复扣费")),
        h("button", { class: "chip", onclick: async () => {
          close();
          const id = await window.__seedance.prompt("按任务 ID 续查", "粘贴 task_… 开头的任务 ID");
          if (id) resumeTask(n.id, id.trim());
        } }, "输入 ID")));
  }, { place: "top", class: "adv-pop" });
}

function presetMenu(anchor, ta, n, list) {
  popover(anchor, (close) => h("div", { class: "presets" }, list.map(([name, text]) =>
    h("button", { class: "preset", title: text, onclick: () => {
      insertText(ta, n, text); close();
    } }, name))), { place: "top" });
}

function insertText(ta, n, text) {
  const v = ta.value;
  const s = ta.selectionStart ?? v.length, e = ta.selectionEnd ?? v.length;
  const before = v.slice(0, s), after = v.slice(e);
  const sep = before && !/[\s，。,.\n]$/.test(before) ? "，" : "";
  ta.value = before + sep + text + after;
  checkpoint(); n.data.prompt = ta.value; markDirty();
  ta.focus();
  const pos = (before + sep + text).length;
  ta.setSelectionRange(pos, pos);
  ta.dispatchEvent(new Event("input"));
}

function mentionMenu(ta, n, media) {
  if (!media.length) return;
  const r = ta.getBoundingClientRect();
  menu(null, [
    { title: "引用已连接的素材" },
    ...media.map((m, i) => ({
      label: `${m.kind === "image" ? "图" + (i + 1) : m.kind === "video" ? "视频" : "音频"} · ${ROLE_LABEL[m.role]}`,
      hint: m.title,
      onClick: () => {
        const tag = m.kind === "image" ? `图${i + 1}` : m.kind === "video" ? "参考视频" : "参考音频";
        const s = ta.selectionStart;
        ta.value = ta.value.slice(0, s - 1) + `[${tag}]` + ta.value.slice(s);
        n.data.prompt = ta.value; markDirty();
        ta.focus();
      },
    })),
  ], { at: { x: r.left + 12, y: r.bottom - 6 } });
}

function addRefMenu(anchor, n) {
  menu(anchor, [
    { label: "上传图片", icon: "image", onClick: () => window.__seedance.pickAndLink(n.id, "image") },
    { label: "上传音频", icon: "audio", onClick: () => window.__seedance.pickAndLink(n.id, "audio") },
    { label: "参考视频外链", icon: "link", onClick: () => window.__seedance.linkVideoUrl(n.id) },
    { label: "从资源库选", icon: "library", onClick: () => window.__seedance.openLibrary({ link: n.id }) },
    { label: "添加文本节点", icon: "text", onClick: () => {
      const t = addNode("text", n.x - 330, n.y + (inputsOf(n.id).length * 40));
      connect(t.id, n.id); select([t.id]);
    } },
  ], { place: "top" });
}

/* ---------- 润色 / 翻译 ---------- */
const SYS = {
  polish: "你是视频生成提示词专家。把用户的描述改写成适合 Seedance 视频模型的中文提示词：明确主体、动作、场景、镜头运动、光影和氛围，保留用户原意和所有关键细节，不超过 200 字。只输出改写后的提示词本身，不要解释、不要引号。",
  translate: "把下面的视频提示词翻译成另一种语言：中文译成英文，英文译成中文。保留专业术语和镜头描述。只输出译文，不要解释。",
};
async function aiRewrite(btn, n, ta, kind) {
  const src = composePrompt(n, collectInputs(n).texts) || ta.value;
  if (!src.trim()) { toast("先写点提示词", "warn"); return; }
  const conn = getConn();
  if (!conn.apiKey) { toast("请先在设置里填写 API Key", "err"); window.__seedance.openSettings(); return; }
  btn.disabled = true; btn.classList.add("spin");
  try {
    const out = await chat(conn, SYS[kind], ta.value.trim() || src);
    checkpoint(); n.data.prompt = out; ta.value = out; markDirty();
    toast(kind === "polish" ? "已润色，⌘Z 可撤销" : "已翻译，⌘Z 可撤销", "ok");
  } catch (e) {
    toast(`${kind === "polish" ? "润色" : "翻译"}失败：${e.message}（可在设置里换对话模型）`, "err", 5000);
  } finally { btn.disabled = false; btn.classList.remove("spin"); }
}
