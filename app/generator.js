/* =========================================================================
   生成：收集输入 → 校验 → 提交 → 轮询 → 结果入库
   任务 ID 一提交就写进节点并保存，刷新 / 重开项目后自动续查。
   ========================================================================= */
import { state, getNode, inputsOf, markDirty, flush, emit } from "./store.js";
import {
  buildBody, validate, submitTask, fetchTask, extractResult, durationCheck, errText, humanError,
  roleForImage, signedUrlExpiry, estimate, modelByFamily, DEFAULT_CONN, ROLE_LABEL,
} from "../lib/seedance.js";
import { imageDataUrl, audioDataUrl, importRemote } from "./library.js";
import { toast } from "./ui.js";

const CONN_KEY = "seedance-canvas-conn";
/** 本机默认值：来自 local.config.json（不进 Git），由 loadLocalDefaults() 填充 */
let localDefaults = {};
export async function loadLocalDefaults() {
  try { const r = await fetch("/api/defaults"); if (r.ok) localDefaults = (await r.json()) || {}; } catch {}
}
export function getConn() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(CONN_KEY) || "{}"); } catch {}
  // 空字符串不覆盖默认值，否则旧版存下的空地址会盖掉本机配置
  const nonEmpty = Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== "" && v != null));
  return { ...DEFAULT_CONN, ...localDefaults, ...nonEmpty };
}
export function setConn(c) { localStorage.setItem(CONN_KEY, JSON.stringify({ ...getConn(), ...c })); }

const POLL_MS = 5000;
const POLL_LIMIT_MS = 30 * 60 * 1000;
const MAX_PARALLEL = 3;
const timers = new Map();      // taskKey → timeout
let listeners = new Set();
export function onTask(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify(nodeId) { for (const fn of listeners) fn(nodeId); }

/* =========================================================
   输入收集
   ========================================================= */
/** 一个视频节点的全部输入：文本、素材（带角色）、问题 */
export function collectInputs(node) {
  const ins = inputsOf(node.id);
  const texts = [], media = [], issues = [];
  const mode = node.data.mode || "t2v";
  const overrides = node.data.roles || {};
  let imgIndex = 0;

  for (const src of ins) {
    if (src.kind === "text") {
      const t = String(src.data.text || "").trim();
      if (t) texts.push({ nodeId: src.id, text: t, title: src.title });
      continue;
    }
    if (src.kind === "image") {
      if (!src.data.file && !src.data.url) { issues.push(`「${src.title}」还没有图片`); continue; }
      const role = overrides[src.id] || roleForImage(mode, imgIndex++);
      media.push({ nodeId: src.id, kind: "image", role, title: src.title, file: src.data.file, url: src.data.url });
      continue;
    }
    if (src.kind === "audio") {
      if (!src.data.file && !src.data.url) { issues.push(`「${src.title}」还没有音频`); continue; }
      media.push({ nodeId: src.id, kind: "audio", role: "reference_audio", title: src.title, file: src.data.file, url: src.data.url });
      continue;
    }
    if (src.kind === "video") {
      // 上游是生成节点 → 默认取尾帧作首帧（续写）
      const r = src.data.results?.[src.data.active || 0];
      if (src.data.results?.length || src.data.mode !== undefined) {
        const frameFile = r?.lastFrameFile, frameUrl = r?.lastFrameUrl;
        const asVideo = overrides[src.id] === "reference_video";
        if (asVideo) {
          const remote = r?.remoteUrl;
          const exp = remote ? signedUrlExpiry(remote) : null;
          if (!remote) issues.push(`「${src.title}」还没有生成结果`);
          else if (exp && exp < Date.now() + 10 * 60 * 1000) issues.push(`「${src.title}」的云端链接已过期，不能再当参考视频`);
          else media.push({ nodeId: src.id, kind: "video", role: "reference_video", title: src.title, url: remote });
        } else if (frameFile || frameUrl) {
          const role = overrides[src.id] || (imgIndex === 0 ? "first_frame" : roleForImage(mode, imgIndex));
          imgIndex++;
          media.push({ nodeId: src.id, kind: "image", role, title: src.title + " · 尾帧", file: frameFile, url: frameUrl });
        } else if (r) {
          issues.push(`「${src.title}」生成时没开「返回尾帧」，无法续写`);
        } else {
          issues.push(`「${src.title}」还没有生成结果`);
        }
        continue;
      }
      // 素材视频节点（上传或外链）→ 参考视频，只能用公网 URL
      if (src.data.url && /^https?:/i.test(src.data.url)) {
        media.push({ nodeId: src.id, kind: "video", role: "reference_video", title: src.title, url: src.data.url });
      } else {
        issues.push(`「${src.title}」是本地视频，方舟只接受公网链接作为参考视频`);
      }
    }
  }
  return { texts, media, issues };
}

/** 拼最终提示词：连进来的文本在前，面板里写的在后 */
export function composePrompt(node, texts) {
  const parts = texts.map(t => t.text);
  const own = String(node.data.prompt || "").trim();
  if (own) parts.push(own);
  return parts.join("\n");
}

/** 节点级校验（不含连接信息），用于标红和置灰提交按钮 */
export function nodeIssue(node, withConn = false) {
  const { texts, media, issues } = collectInputs(node);
  if (issues.length) return issues[0];
  const prompt = composePrompt(node, texts);
  const p = { ...node.data.params, modelId: modelByFamily(node.data.params.family).id };
  return validate(p, prompt, media.map(m => ({ kind: m.kind, role: m.role })), withConn ? getConn() : null);
}

export function nodeEstimate(node) {
  const { media } = collectInputs(node);
  return estimate(node.data.params, media);
}

/* =========================================================
   提交
   ========================================================= */
let runningCount = 0;
const queue = [];

export function isBusy(node) {
  return node.data.task && node.data.task.phase === "run";
}

export async function generate(nodeId) {
  const node = getNode(nodeId);
  if (!node || node.kind !== "video") return;
  if (isBusy(node)) { toast("这个节点正在生成中", "warn"); return; }
  const err = nodeIssue(node, true);
  if (err) { toast(err, "err"); return; }
  const count = Math.max(1, Math.min(4, Number(node.data.params.count) || 1));
  node.data.task = { phase: "run", status: "准备中", startedAt: Date.now(), jobs: [] };
  node.data.lastError = null;
  markDirty(); notify(nodeId);

  for (let i = 0; i < count; i++) {
    await enqueue(() => submitOne(nodeId, i, count));
  }
}

function enqueue(fn) {
  return new Promise((resolve) => {
    queue.push(async () => { try { await fn(); } finally { runningCount--; resolve(); pump(); } });
    pump();
  });
}
function pump() {
  while (runningCount < MAX_PARALLEL && queue.length) { runningCount++; queue.shift()(); }
}

async function submitOne(nodeId, index, total) {
  const node = getNode(nodeId);
  if (!node) return;
  const conn = getConn();
  const p = { ...node.data.params, modelId: modelByFamily(node.data.params.family).id };
  try {
    setTaskStatus(node, total > 1 ? `准备素材 ${index + 1}/${total}` : "准备素材");
    const { texts, media } = collectInputs(node);
    const prompt = composePrompt(node, texts);
    const assets = [];
    for (const m of media) {
      let url = m.url;
      if (m.kind === "image" && m.file) url = await imageDataUrl(m.file);
      if (m.kind === "audio" && m.file) url = await audioDataUrl(m.file);
      if (!url) throw new Error(`「${m.title}」读取失败`);
      assets.push({ kind: m.kind, role: m.role, url });
    }
    const body = buildBody(p, prompt, assets, conn.protocol);
    setTaskStatus(node, total > 1 ? `提交中 ${index + 1}/${total}` : "提交中");
    const { id } = await submitTask(conn, body);

    // 任务 ID 立刻落盘
    const job = {
      id, index, phase: "run", status: "已提交", submittedAt: Date.now(),
      request: { duration: Number(p.duration), resolution: p.resolution, ratio: p.ratio, family: p.family,
                 model: p.modelId, prompt, seed: p.seed, generateAudio: p.generateAudio,
                 returnLastFrame: p.returnLastFrame, hasVideoRef: assets.some(a => a.kind === "video") },
    };
    node.data.task.jobs.push(job);
    markDirty(); await flush();
    notify(nodeId);
    schedulePoll(nodeId, id, 1500);
  } catch (e) {
    console.error(e);
    const msg = humanError(e);
    node.data.task.jobs.push({ id: null, index, phase: "fail", error: msg, raw: e.raw ?? null });
    finishIfDone(node);
    toast(`提交失败：${msg}`, "err", 5000);
  }
}

function setTaskStatus(node, status) {
  if (!node.data.task) return;
  node.data.task.status = status;
  notify(node.id);
}

/* =========================================================
   轮询
   ========================================================= */
function schedulePoll(nodeId, taskId, delay = POLL_MS) {
  const key = nodeId + ":" + taskId;
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => pollOnce(nodeId, taskId), delay));
}

async function pollOnce(nodeId, taskId) {
  const key = nodeId + ":" + taskId;
  timers.delete(key);
  const node = getNode(nodeId);
  if (!node || !node.data.task) return;
  const job = node.data.task.jobs.find(j => j.id === taskId);
  if (!job || job.phase !== "run") return;

  try {
    const r = await fetchTask(getConn(), taskId);
    job.status = r.status;
    job.progress = r.progress;
    job.lastRaw = r.raw;
    job.pollErrors = 0;

    if (r.phase === "ok") {
      await onSuccess(node, job, r);
      return;
    }
    if (r.phase === "fail") {
      job.phase = "fail";
      job.error = errText(r.data);
      toast(`「${node.title}」生成失败：${job.error}`, "err", 6000);
      finishIfDone(node);
      return;
    }
    if (Date.now() - (job.submittedAt || Date.now()) > POLL_LIMIT_MS) {
      job.phase = "stalled";
      job.error = `等了 30 分钟仍是「${r.status}」，已停止自动查询`;
      finishIfDone(node);
      return;
    }
    notify(nodeId);
    schedulePoll(nodeId, taskId);
  } catch (e) {
    job.pollErrors = (job.pollErrors || 0) + 1;
    job.status = "查询出错，重试中";
    notify(nodeId);
    if (job.pollErrors >= 6) {
      job.phase = "stalled";
      job.error = "连续查询失败：" + humanError(e);
      finishIfDone(node);
      return;
    }
    schedulePoll(nodeId, taskId, POLL_MS * 2);
  }
}

async function onSuccess(node, job, r) {
  const res = extractResult(r.data);
  job.status = "下载中";
  notify(node.id);
  const result = {
    taskId: job.id,
    createdAt: Date.now(),
    remoteUrl: res.video,
    lastFrameUrl: res.lastFrame,
    duration: res.duration, resolution: res.resolution, ratio: res.ratio, fps: res.fps,
    tokens: res.tokens, quota: res.quota, seed: res.seed,
    request: job.request,
  };
  const rate = estimate({ family: job.request.family, resolution: job.request.resolution, ratio: job.request.ratio, duration: 1 },
                        job.request.hasVideoRef ? [{ kind: "video" }] : []).coef;
  if (res.tokens) result.cost = +(res.tokens * rate / 1e6).toFixed(4);
  result.check = durationCheck(job.request.duration, res.duration);

  if (!res.video) {
    job.phase = "fail";
    job.error = "任务成功，但响应里没有视频地址";
    finishIfDone(node);
    return;
  }

  // 入库：服务端下载到项目 assets/
  const label = `${node.title}_${String(job.id).slice(-8)}`;
  const meta = { prompt: job.request.prompt, params: job.request, taskId: job.id, tokens: res.tokens,
                 cost: result.cost, nodeId: node.id, duration: res.duration, resolution: res.resolution };
  try {
    const item = await importRemote(res.video, "video", node.title, label, meta);
    result.file = item.file; result.assetId = item.id;
  } catch (e) {
    result.downloadError = e.message;
    toast(`成片已生成，但保存到项目失败：${e.message}。24 小时内可在节点上重试。`, "warn", 7000);
  }
  if (res.lastFrame) {
    try {
      const item = await importRemote(res.lastFrame, "image", node.title + " 尾帧", label + "_尾帧",
                                      { taskId: job.id, nodeId: node.id, lastFrameOf: result.assetId });
      result.lastFrameFile = item.file; result.lastFrameAssetId = item.id;
    } catch (e) { console.warn("尾帧保存失败", e); }
  }

  node.data.results = node.data.results || [];
  node.data.results.unshift(result);
  node.data.active = 0;
  job.phase = "ok";
  if (result.check && !result.check.ok) toast(`「${node.title}」${result.check.text}`, "warn", 6000);
  finishIfDone(node);
}

function finishIfDone(node) {
  const t = node.data.task;
  if (!t) return;
  const expect = Math.max(1, Math.min(4, Number(node.data.params.count) || 1));
  const done = t.jobs.filter(j => j.phase !== "run").length;
  if (t.jobs.length >= expect && done === t.jobs.length) {
    const fails = t.jobs.filter(j => j.phase !== "ok");
    if (fails.length) node.data.lastError = { message: fails[0].error || "生成失败", taskId: fails[0].id, raw: fails[0].lastRaw || fails[0].raw || null, at: Date.now() };
    node.data.task = null;
  }
  markDirty(); flush();
  notify(node.id);
  emit("task");
}

/** 停止自动查询（不会取消服务端任务，也不会退费） */
export function stopTask(nodeId) {
  const node = getNode(nodeId);
  if (!node?.data.task) return;
  for (const j of node.data.task.jobs) {
    if (j.phase === "run") {
      clearTimeout(timers.get(nodeId + ":" + j.id));
      j.phase = "stalled";
      j.error = "已停止查询（服务端任务仍在跑，仍会计费；稍后可按任务 ID 续查）";
    }
  }
  finishIfDone(node);
}

/** 按任务 ID 续查（刷新后 / 停止后 / 外部任务） */
export function resumeTask(nodeId, taskId) {
  const node = getNode(nodeId);
  if (!node) return;
  if (!node.data.task) node.data.task = { phase: "run", status: "续查中", startedAt: Date.now(), jobs: [] };
  else node.data.task.phase = "run";
  let job = node.data.task.jobs.find(j => j.id === taskId);
  if (!job) {
    job = { id: taskId, index: node.data.task.jobs.length, phase: "run", status: "续查中", submittedAt: Date.now(),
            request: { ...node.data.params, model: modelByFamily(node.data.params.family).id, prompt: node.data.prompt, hasVideoRef: false } };
    node.data.task.jobs.push(job);
  } else { job.phase = "run"; job.submittedAt = Date.now(); job.error = null; }
  // 续查时 count 以实际 jobs 数为准
  node.data.params.count = Math.max(node.data.task.jobs.length, 1);
  node.data.lastError = null;
  markDirty(); notify(nodeId);
  schedulePoll(nodeId, taskId, 100);
}

/** 打开项目后：所有还在跑的任务接着查 */
export function resumeAll() {
  let n = 0;
  for (const node of state.nodes) {
    const t = node.data?.task;
    if (!t) continue;
    t.phase = "run";
    for (const j of t.jobs || []) {
      if (j.phase === "run" && j.id) { schedulePoll(node.id, j.id, 300 + n * 400); n++; }
    }
    if (!(t.jobs || []).some(j => j.phase === "run")) finishIfDone(node);
  }
  if (n) toast(`接着查询 ${n} 个未完成的任务`, "info");
}

export function stopAllTimers() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

/** 结果保存失败时重试下载 */
export async function retryDownload(nodeId, resultIndex) {
  const node = getNode(nodeId);
  const r = node?.data.results?.[resultIndex];
  if (!r?.remoteUrl) return;
  const exp = signedUrlExpiry(r.remoteUrl);
  if (exp && exp < Date.now()) { toast("云端链接已过期（24 小时），无法再下载", "err"); return; }
  try {
    const item = await importRemote(r.remoteUrl, "video", node.title, `${node.title}_${String(r.taskId).slice(-8)}`,
                                    { taskId: r.taskId, nodeId, prompt: r.request?.prompt, params: r.request });
    r.file = item.file; r.assetId = item.id; delete r.downloadError;
    markDirty(); notify(nodeId);
    toast("已保存到项目", "ok");
  } catch (e) { toast("保存失败：" + e.message, "err"); }
}

export { ROLE_LABEL };
