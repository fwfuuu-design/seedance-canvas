/* =========================================================================
   共用 UI 工具：DOM 构建、图标、弹层、提示、确认框、接口请求
   ========================================================================= */

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/** h("div", { class: "x", onclick: fn, style: { left: "1px" } }, child, "text") */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** 替换子节点。原生 replaceChildren 会把 null / false 当成文字 "null" 插进去，这里先过滤掉 */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false));
  return el;
}

export function icon(name, size = 16) {
  const span = document.createElement("span");
  span.className = "ic";
  span.innerHTML = (ICONS[name] || "").replace("<svg ", `<svg width="${size}" height="${size}" `);
  return span;
}

const S = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
export const ICONS = {
  play:      `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12.5-7.5z"/></svg>`,
  text:      `<svg ${S}><path d="M5 6h14M5 10h14M5 14h14M5 18h9"/></svg>`,
  image:     `<svg ${S}><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m20 16-4.5-4.5L7 20"/></svg>`,
  audio:     `<svg ${S}><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>`,
  video:     `<svg ${S}><rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10 5-3v10l-5-3"/></svg>`,
  link:      `<svg ${S}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>`,
  plus:      `<svg ${S}><path d="M12 5v14M5 12h14"/></svg>`,
  expand:    `<svg ${S}><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>`,
  collapse:  `<svg ${S}><path d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7"/></svg>`,
  polish:    `<svg ${S}><path d="M4 5h9M4 9h6M4 13h5M4 17h7"/><path d="m17 8 .9 2.1L20 11l-2.1.9L17 14l-.9-2.1L14 11l2.1-.9zM15 16l.6 1.4L17 18l-1.4.6L15 20l-.6-1.4L13 18l1.4-.6z"/></svg>`,
  translate: `<svg ${S}><path d="M4 6h9M8.5 4v2c0 4-2 7-4.5 8.5M6 9.5c1 2 3 3.8 5.5 4.5"/><path d="m13 20 3.5-8 3.5 8M14.2 17.3h4.6"/></svg>`,
  sliders:   `<svg ${S}><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>`,
  up:        `<svg ${S} stroke-width="2.2"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`,
  close:     `<svg ${S}><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  library:   `<svg ${S}><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>`,
  settings:  `<svg ${S}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
  folder:    `<svg ${S}><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>`,
  chevron:   `<svg ${S}><path d="m7 10 5 5 5-5"/></svg>`,
  left:      `<svg ${S}><path d="m14 6-6 6 6 6"/></svg>`,
  right:     `<svg ${S}><path d="m10 6 6 6-6 6"/></svg>`,
  camera:    `<svg ${S}><path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/></svg>`,
  sparkle:   `<svg ${S}><path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>`,
  movie:     `<svg ${S}><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/></svg>`,
  layers:    `<svg ${S}><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>`,
  continue:  `<svg ${S}><path d="M4 12h12M12 6l6 6-6 6"/><path d="M20 5v14"/></svg>`,
  volume:    `<svg ${S}><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>`,
  mute:      `<svg ${S}><path d="M4 9v6h4l5 4V5L8 9z"/><path d="m17 9 5 6M22 9l-5 6"/></svg>`,
  copy:      `<svg ${S}><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`,
  download:  `<svg ${S}><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>`,
  trash:     `<svg ${S}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>`,
  locate:    `<svg ${S}><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`,
  refresh:   `<svg ${S}><path d="M20 11a8 8 0 0 0-14.7-4.3L4 8M4 4v4h4M4 13a8 8 0 0 0 14.7 4.3L20 16M20 20v-4h-4"/></svg>`,
  upload:    `<svg ${S}><path d="M12 20V9M7 14l5-5 5 5M5 4h14"/></svg>`,
  search:    `<svg ${S}><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>`,
  zoomin:    `<svg ${S}><path d="M12 5v14M5 12h14"/></svg>`,
  zoomout:   `<svg ${S}><path d="M5 12h14"/></svg>`,
  fit:       `<svg ${S}><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/></svg>`,
  batch:     `<svg ${S}><rect x="3" y="7" width="12" height="10" rx="2"/><path d="M19 7v10M22 9v6"/></svg>`,
  warn:      `<svg ${S}><path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17.5v.01"/></svg>`,
  check:     `<svg ${S}><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`,
};

/* ---------------- 提示 ---------------- */
export function toast(msg, kind = "info", ms = 2800) {
  let box = $("#toasts");
  if (!box) { box = h("div", { id: "toasts" }); document.body.appendChild(box); }
  const t = h("div", { class: `toast ${kind}` }, msg);
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 250); }, ms);
}

/* ---------------- 弹层 ---------------- */
let openPop = null;
/**
 * 在 anchor 附近打开一个弹层。build(close) 返回内容节点。
 * opts.at = {x, y} 时按屏幕坐标定位；opts.place = "top" | "bottom"
 */
export function popover(anchor, build, opts = {}) {
  closePopover();
  const pop = h("div", { class: "pop " + (opts.class || "") });
  const close = () => {
    if (openPop !== state) return;
    pop.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", esc, true);
    openPop = null;
    opts.onClose?.();
  };
  const state = { close, pop };
  pop.appendChild(build(close));
  document.body.appendChild(pop);

  const pr = pop.getBoundingClientRect();
  let x, y;
  if (opts.at) { x = opts.at.x; y = opts.at.y; }
  else {
    const r = anchor.getBoundingClientRect();
    x = opts.align === "right" ? r.right - pr.width : r.left;
    y = opts.place === "top" ? r.top - pr.height - 8 : r.bottom + 8;
    if (opts.place !== "top" && y + pr.height > innerHeight - 8) y = r.top - pr.height - 8;
    if (opts.place === "top" && y < 8) y = r.bottom + 8;
  }
  x = Math.max(8, Math.min(x, innerWidth - pr.width - 8));
  y = Math.max(8, Math.min(y, innerHeight - pr.height - 8));
  pop.style.left = x + "px"; pop.style.top = y + "px";

  const outside = (e) => { if (!pop.contains(e.target) && !(anchor && anchor.contains?.(e.target))) close(); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  setTimeout(() => {
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", esc, true);
  });
  openPop = state;
  return close;
}
export function closePopover() { openPop?.close(); }
export function popoverOpen() { return !!openPop; }

/** 菜单：items = [{ label, icon, hint, onClick, disabled, danger } | "-"] */
export function menu(anchor, items, opts = {}) {
  return popover(anchor, (close) => h("div", { class: "menu" },
    items.map((it) => it === "-" ? h("div", { class: "menu-sep" }) :
      it.title ? h("div", { class: "menu-title" }, it.title) :
      h("button", {
        class: "menu-item" + (it.danger ? " danger" : "") + (it.active ? " active" : ""),
        disabled: it.disabled,
        title: it.tip,
        onclick: () => { close(); it.onClick?.(); },
      }, it.icon ? icon(it.icon) : null, h("span", { class: "menu-label" }, it.label),
         it.hint ? h("span", { class: "menu-hint" }, it.hint) : null))
  ), opts);
}

/* ---------------- 对话框 ---------------- */
export function modal(build, { width = 460, onClose } = {}) {
  const back = h("div", { class: "modal-back" });
  const box = h("div", { class: "modal", style: { width: width + "px" } });
  const close = () => { back.remove(); document.removeEventListener("keydown", esc, true); onClose?.(); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  box.appendChild(build(close));
  back.appendChild(box);
  back.addEventListener("pointerdown", (e) => { if (e.target === back) close(); });
  document.addEventListener("keydown", esc, true);
  document.body.appendChild(back);
  return close;
}

export function confirmDialog(title, text, { ok = "确定", danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const close = modal((close) => h("div", { class: "dlg" },
      h("div", { class: "dlg-title" }, title),
      text ? h("div", { class: "dlg-text" }, text) : null,
      h("div", { class: "dlg-actions" },
        h("button", { class: "btn", onclick: () => { done = true; close(); resolve(false); } }, "取消"),
        h("button", { class: "btn " + (danger ? "danger" : "primary"), onclick: () => { done = true; close(); resolve(true); } }, ok))
    ), { width: 400, onClose: () => { if (!done) resolve(false); } });
  });
}

/* ---------------- 格式化 ---------------- */
export function fmtBytes(n) {
  if (!n) return "";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}
export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
export function fmtYuan(v) { return "¥" + (Number(v) || 0).toFixed(2); }
export function fmtTime(ts) {
  const d = new Date(ts); const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function copyText(text, label = "已复制") {
  try { await navigator.clipboard.writeText(text); toast(label, "ok", 1400); }
  catch { toast("复制失败，请手动选择复制", "err"); }
}

/* ---------------- 接口 ---------------- */
export async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: {} };
  if (opts.body !== undefined) {
    if (opts.raw) { init.body = opts.body; if (opts.type) init.headers["Content-Type"] = opts.type; }
    else { init.body = JSON.stringify(opts.body); init.headers["Content-Type"] = "application/json"; }
  }
  const r = await fetch(path, init);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const e = new Error(data?.error?.message || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

export const fileUrl = (file) => "/files/" + encodeURIComponent(file);

/** 本地读出文件 → 选择器 */
export function pickFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, multiple, style: { display: "none" } });
    input.addEventListener("change", () => { resolve(Array.from(input.files || [])); input.remove(); });
    // 用户取消时不会触发 change；focus 回来后清理
    window.addEventListener("focus", () => setTimeout(() => { if (!input.files?.length) { resolve([]); input.remove(); } }, 400), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}
