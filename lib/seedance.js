/* =========================================================================
   Seedance 网关接口层
   纯函数，不读全局状态；行为已用真实任务验证。
   目标网关：New API（实测 v1.0.0-rc.40）
   ========================================================================= */

export const DEFAULT_CONN = {
  baseUrl: "",
  apiKey: "",
  protocol: "newapi",
  createPath: "/v1/video/generations",
  fetchPath: "/v1/video/generations",
  chatModel: "claude-sonnet-5",
};

/* 模型与能力 —— 取自网关 /api/pricing 的 billing_usage_schema */
export const MODELS = [
  { key: "2.5", label: "Seedance 2.5", id: "doubao-seedance-2-5-260628", family: "2.5",
    resolutions: ["480p", "720p", "1080p"], maxDuration: 30 },
  { key: "2.0", label: "Seedance 2.0", id: "doubao-seedance-2-0-260128", family: "2.0",
    resolutions: ["480p", "720p", "1080p", "4k"], maxDuration: 15 },
];

/* 网关计费系数：元 / 百万 token（tiered_expr 里的乘数） */
export const RATE = {
  "2.5": { "480p": { none: 70, video: 42 }, "720p": { none: 70, video: 42 }, "1080p": { none: 77, video: 46 } },
  "2.0": { "480p": { none: 46, video: 28 }, "720p": { none: 46, video: 28 },
           "1080p": { none: 51, video: 31 }, "4k": { none: 26, video: 16 } },
};

export const RATIOS = ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];

/* 档位按「像素预算」定：480p 基准 854×480，换成 4:3 是 752×560（实测验证） */
export const TIER_REF = { "480p": [854, 480], "720p": [1280, 720], "1080p": [1920, 1080], "4k": [3840, 2160] };

export function dimsFor(resolution, ratio) {
  const ref = TIER_REF[resolution] || TIER_REF["720p"];
  const m = /^(\d+):(\d+)$/.exec(String(ratio || ""));
  if (!m || (m[1] === "16" && m[2] === "9")) return ref;
  const px = ref[0] * ref[1];
  const r = Number(m[1]) / Number(m[2]);
  const a16 = (x) => Math.max(16, Math.round(x / 16) * 16);
  const h = a16(Math.sqrt(px / r));
  return [a16(h * r), h];
}

export function modelByFamily(family) {
  return MODELS.find(m => m.family === family) || MODELS[0];
}

/** 网关在 15–20 MB 之间直接断开连接且不回 CORS 头，提前拦住 */
export const MAX_BODY_BYTES = 14 * 1024 * 1024;

/* 生成参数的默认值 */
export const DEFAULT_PARAMS = {
  family: "2.5",
  modelId: "doubao-seedance-2-5-260628",
  resolution: "720p",
  ratio: "16:9",
  duration: 5,
  count: 1,
  generateAudio: true,
  watermark: false,
  cameraFixed: false,
  returnLastFrame: false,
  seed: -1,
  expiresAfter: 43200,
};

/* =========================================================
   角色
   ========================================================= */
/** 按模式给第 i 张图分配角色 */
export function roleForImage(mode, i) {
  if (mode === "first")     return i === 0 ? "first_frame" : "reference_image";
  if (mode === "firstlast") return i === 0 ? "first_frame" : i === 1 ? "last_frame" : "reference_image";
  return "reference_image";
}

export const ROLE_LABEL = {
  first_frame: "首帧", last_frame: "尾帧", reference_image: "参考图",
  reference_video: "参考视频", reference_audio: "参考音频",
};

/* =========================================================
   请求体
   assets: [{ kind: "image"|"video"|"audio", url, role }]
   ========================================================= */
export function contentParts(assets) {
  const parts = [];
  for (const a of assets) {
    if (a.kind === "image")      parts.push({ type: "image_url", image_url: { url: a.url }, role: a.role });
    else if (a.kind === "video") parts.push({ type: "video_url", video_url: { url: a.url }, role: "reference_video" });
    else                         parts.push({ type: "audio_url", audio_url: { url: a.url }, role: "reference_audio" });
  }
  return parts;
}

export function buildBody(params, prompt, assets, protocol = "newapi") {
  const p = { ...DEFAULT_PARAMS, ...params };
  const parts = contentParts(assets || []);
  let dur = Number(p.duration);
  // 「自动」时长（-1 / 0）改成 5 秒：网关只接受 1–3600，不支持自动选择
  if (dur <= 0) dur = 5;
  const text = String(prompt || "").trim();

  if (protocol === "ark") {
    const content = [];
    if (text) content.push({ type: "text", text });
    content.push(...parts);
    const b = {
      model: p.modelId, content,
      resolution: p.resolution, ratio: p.ratio, duration: dur,
      generate_audio: !!p.generateAudio, watermark: !!p.watermark,
      camera_fixed: !!p.cameraFixed, return_last_frame: !!p.returnLastFrame,
      seed: Number(p.seed), execution_expires_after: Number(p.expiresAfter),
    };
    if (p.draft) b.draft = true;
    if (p.webSearch) b.tools = [{ type: "web_search" }];
    return b;
  }

  // New API：prompt 顶层；duration 顶层和 metadata 都写 ——
  // doubao 插件只展开 metadata，只写顶层会被丢掉、上游回退 -1 自动选时长（实测 4s → 10s）
  const metadata = {
    resolution: p.resolution, ratio: p.ratio, duration: dur,
    generate_audio: !!p.generateAudio, watermark: !!p.watermark,
    camera_fixed: !!p.cameraFixed, return_last_frame: !!p.returnLastFrame,
    seed: Number(p.seed), execution_expires_after: Number(p.expiresAfter),
  };
  if (parts.length) metadata.content = parts;
  if (p.draft) metadata.draft = true;
  if (p.webSearch) metadata.tools = [{ type: "web_search" }];
  return { model: p.modelId, prompt: text, duration: dur, metadata };
}

/** 预览用：截短 base64 */
export function previewBody(body) {
  const clone = JSON.parse(JSON.stringify(body));
  const scan = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const c of arr) {
      const u = c.image_url || c.audio_url || c.video_url;
      if (u && typeof u.url === "string" && u.url.length > 110)
        u.url = u.url.slice(0, 62) + `…[省略 ${u.url.length} 字符]`;
    }
  };
  scan(clone.content);
  scan(clone.metadata && clone.metadata.content);
  return clone;
}

/* =========================================================
   校验
   ========================================================= */
export function validate(params, prompt, assets, conn) {
  const p = { ...DEFAULT_PARAMS, ...params };
  if (conn) {
    if (!String(conn.baseUrl || "").trim()) return "请先在设置里填写网关地址";
    if (!String(conn.apiKey || "").trim()) return "请先在设置里填写 API Key";
  }
  if (!String(p.modelId || "").trim()) return "请先选择模型";
  if (!String(prompt || "").trim() && !(assets || []).length) return "写一段提示词，或者连一个参考素材";

  const roles = (assets || []).map(a => a.role);
  const frames = roles.filter(r => r === "first_frame" || r === "last_frame").length;
  const refs = roles.filter(r => r && r.startsWith("reference_")).length;
  if (frames && refs) return "首帧 / 尾帧 与 参考素材不能同时使用";
  if (roles.filter(r => r === "first_frame").length > 1) return "首帧只能有一张";
  if (roles.filter(r => r === "last_frame").length > 1) return "尾帧只能有一张";
  if (roles.includes("last_frame") && !roles.includes("first_frame")) return "有尾帧就必须有首帧";

  const m = modelByFamily(p.family);
  if (!m.resolutions.includes(p.resolution)) return `Seedance ${p.family} 不支持 ${p.resolution}`;
  const dur = Number(p.duration);
  // -1 = 自动，提交时会改成 5 秒，这里不拦
  if (dur !== -1 && (dur < 4 || dur > m.maxDuration))
    return `Seedance ${p.family} 时长须在 4–${m.maxDuration} 秒`;

  const imgs = (assets || []).filter(a => a.kind === "image").length;
  const vids = (assets || []).filter(a => a.kind === "video").length;
  const auds = (assets || []).filter(a => a.kind === "audio").length;
  const [imgMax, vidMax, audMax] = p.family === "2.5" ? [30, 10, 10] : [9, 3, 3];
  if (imgs > imgMax) return `图片最多 ${imgMax} 张`;
  if (vids > vidMax) return `参考视频最多 ${vidMax} 段`;
  if (auds > audMax) return `参考音频最多 ${audMax} 段`;
  return null;
}

/* =========================================================
   估算
   ========================================================= */
export function estimate(params, assets) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const [w, h] = dimsFor(p.resolution, p.ratio);
  const sec = Number(p.duration) > 0 ? Number(p.duration) : 5;
  const tokens = Math.round(w * h * 24 * sec / 1024);
  const hasVideo = (assets || []).some(a => a.kind === "video");
  const rate = (RATE[p.family] || {})[p.resolution] || { none: 0, video: 0 };
  const coef = hasVideo ? rate.video : rate.none;
  const yuan = tokens * coef / 1e6;
  const count = Math.max(1, Number(p.count) || 1);
  return { tokens, coef, hasVideo, w, h, sec, yuan, count, total: yuan * count, auto: Number(p.duration) === -1 };
}

/* =========================================================
   响应解析
   ========================================================= */
export function errText(d) {
  if (!d) return "未知错误";
  if (typeof d === "string") return d.slice(0, 300);
  const e = d.error;
  const msg = (e && typeof e === "object" ? [e.code, e.message].filter(Boolean).join(": ") : e)
           || d.fail_reason || d.message || d.data?.fail_reason;
  return msg ? String(msg) : JSON.stringify(d).slice(0, 300);
}

export function humanError(e) {
  const m = String((e && e.message) || e);
  if (/Failed to fetch|NetworkError|Load failed/i.test(m))
    return "请求发不出去 —— 常见原因：请求体太大被网关断开（参考图过大），或网关地址不对";
  return m.slice(0, 400);
}

/* New API 查询响应带信封：{ code: "success", data: { status: "SUCCESS", ... } } */
export function unwrapTask(raw) {
  if (raw && typeof raw === "object" && raw.data && typeof raw.data === "object"
      && (raw.code !== undefined || raw.success !== undefined)) return raw.data;
  return raw || {};
}

const ST_OK   = ["succeeded", "success", "completed", "finished"];
const ST_FAIL = ["failed", "failure", "error", "expired", "cancelled", "canceled"];

export function phaseOf(st) {
  st = String(st || "").toLowerCase();
  if (ST_OK.includes(st)) return "ok";
  if (ST_FAIL.includes(st)) return "fail";
  return "run";
}

const isUrl = (v) => typeof v === "string" && /^https?:\/\//i.test(v);

/** 从已拆信封的任务对象里取视频 / 尾帧地址和回执 */
export function extractResult(data) {
  const up = (data && data.data && typeof data.data === "object") ? data.data : {};
  const video = [data.result_url, data.url, data.metadata?.url, data.content?.video_url,
                 up.content?.video_url, up.url, up.video_url, data.video_url,
                 data.fail_reason].find(isUrl) || null;
  const lastFrame = [data.last_frame_url, data.content?.last_frame_url, data.metadata?.last_frame_url,
                     up.content?.last_frame_url, up.last_frame_url].find(isUrl) || null;
  const usage = data.usage || up.usage || {};
  return {
    video, lastFrame,
    duration: Number(up.duration ?? data.metadata?.duration ?? data.duration ?? NaN),
    resolution: up.resolution || data.metadata?.resolution || data.resolution || null,
    ratio: up.ratio || null,
    fps: up.framespersecond || data.metadata?.fps || 24,
    tokens: usage.total_tokens ?? null,
    quota: data.quota ?? null,
    seed: up.seed ?? null,
  };
}

/** 时长核对：具体值应严格执行，对不上就是请求被改了 */
export function durationCheck(requested, actual) {
  if (!(Number(requested) > 0) || !Number.isFinite(Number(actual))) return null;
  return Math.abs(Number(actual) - Number(requested)) < 0.5
    ? { ok: true, text: `时长按要求执行：${requested}s` }
    : { ok: false, text: `时长不一致：要 ${requested}s，实际 ${actual}s（按 ${actual}s 计费）` };
}

/** TOS 签名链接过期时间：X-Tos-Date + X-Tos-Expires */
export function signedUrlExpiry(url) {
  try {
    const u = new URL(url);
    const d = u.searchParams.get("X-Tos-Date") || u.searchParams.get("X-Amz-Date");
    const exp = Number(u.searchParams.get("X-Tos-Expires") || u.searchParams.get("X-Amz-Expires"));
    if (!d || !exp) return null;
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(d);
    if (!m) return null;
    return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + exp * 1000;
  } catch { return null; }
}

/* =========================================================
   网络
   ========================================================= */
const base = (conn) => String(conn.baseUrl || "").replace(/\/+$/, "");

export async function submitTask(conn, body) {
  const payload = JSON.stringify(body);
  if (payload.length > MAX_BODY_BYTES)
    throw new Error(`请求体 ${(payload.length / 1048576).toFixed(1)} MB，超过网关约 14 MB 上限 · 请减少或压缩参考图`);
  const res = await fetch(base(conn) + (conn.createPath || ""), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + conn.apiKey },
    body: payload,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { const e = new Error(`返回非 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`); e.raw = text; throw e; }
  if (!res.ok) { const e = new Error(`HTTP ${res.status} · ${errText(data)}`); e.raw = data; throw e; }
  const id = data.task_id || data.id || data.data?.task_id || data.data?.id;
  if (!id) { const e = new Error("响应里没有任务 ID"); e.raw = data; throw e; }
  return { id, raw: data };
}

export async function fetchTask(conn, id) {
  const res = await fetch(base(conn) + (conn.fetchPath || "") + "/" + encodeURIComponent(id),
                          { headers: { "Authorization": "Bearer " + conn.apiKey } });
  const text = await res.text();
  let raw;
  try { raw = JSON.parse(text); }
  catch { raw = { status: "error", error: { message: `查询返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}` } }; }
  const data = unwrapTask(raw);
  if (!res.ok && !data.status) data.status = "error";
  const status = String(data.status || data.state || "unknown");
  return { http: res.status, raw, data, status, phase: phaseOf(status), progress: data.progress || null };
}

/** 调网关里的对话模型（润色 / 翻译） */
export async function chat(conn, system, user) {
  const res = await fetch(base(conn) + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + conn.apiKey },
    body: JSON.stringify({
      model: conn.chatModel || DEFAULT_CONN.chatModel,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.4,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} · ${errText(data)}`);
  const out = data.choices?.[0]?.message?.content;
  if (!out) throw new Error("对话模型没有返回内容");
  return String(out).trim();
}
