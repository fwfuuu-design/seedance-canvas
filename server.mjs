#!/usr/bin/env node
/**
 * Seedance 画布 · 本地服务（零依赖，Node 18+）
 *
 *   node server.mjs            → http://127.0.0.1:8899
 *   PORT=9000 node server.mjs
 *
 * 职责：
 *   1. 提供页面静态文件
 *   2. 项目文件夹：一个文件夹 = 一个项目（canvas.json + assets.json + assets/）
 *   3. 资源库：上传、从远端下载入库（生成结果）、删除
 *   4. 画布存档读写
 *
 * 网关请求由浏览器直连（网关已放行 CORS），本服务不经手 API Key。
 * 只监听 127.0.0.1。
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(APP_ROOT, "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const PORT = Number(process.env.PORT || 8899);
const HOST = "127.0.0.1";

const MAX_UPLOAD = 100 * 1024 * 1024;
const MAX_JSON = 20 * 1024 * 1024;
const MAX_IMPORT = 500 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".heic": "image/heic", ".heif": "image/heif",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
  ".ico": "image/x-icon",
};
const EXT_BY_MIME = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
  "image/bmp": ".bmp", "image/tiff": ".tiff", "image/heic": ".heic", "image/heif": ".heif",
  "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
  "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
  "audio/wave": ".wav", "audio/mp4": ".m4a", "audio/ogg": ".ogg",
};

/* =========================================================
   配置：当前项目 + 最近项目
   ========================================================= */
let config = { current: null, recent: [] };

async function loadConfig() {
  try { config = { current: null, recent: [], ...JSON.parse(await fsp.readFile(CONFIG_FILE, "utf8")) }; }
  catch { /* 首次运行 */ }
  if (config.current && !(await isDir(config.current))) config.current = null;
}
async function saveConfig() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await writeAtomic(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

/** 先写临时文件再改名，进程中途被杀也不会留下半个存档 */
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

function proj() {
  if (!config.current) throw httpErr(409, "还没有打开项目，请先新建或打开一个项目文件夹");
  return {
    root: config.current,
    canvas: path.join(config.current, "canvas.json"),
    index: path.join(config.current, "assets.json"),
    assets: path.join(config.current, "assets"),
  };
}

/** 打开项目：只补齐缺失的三样东西，绝不动文件夹里已有的其他文件 */
async function openProject(dir) {
  dir = path.resolve(String(dir || "").replace(/^~(?=$|\/)/, process.env.HOME || "~"));
  if (!(await isDir(dir))) throw httpErr(400, `文件夹不存在：${dir}`);
  await fsp.mkdir(path.join(dir, "assets"), { recursive: true });
  const idx = path.join(dir, "assets.json");
  if (!fs.existsSync(idx)) await writeAtomic(idx, "[]");
  config.current = dir;
  config.recent = [dir, ...config.recent.filter(p => p !== dir)].slice(0, 12);
  await saveConfig();
  return projectInfo();
}

async function projectInfo() {
  if (!config.current) return { open: false };
  return { open: true, path: config.current, name: path.basename(config.current) };
}

/* =========================================================
   资源库索引
   ========================================================= */
async function readIndex() {
  try { const a = JSON.parse(await fsp.readFile(proj().index, "utf8")); return Array.isArray(a) ? a : []; }
  catch (e) { if (e.status) throw e; return []; }
}
// 同一时刻只允许一个写入者，避免并发入库互相覆盖
let indexLock = Promise.resolve();
function withIndex(fn) {
  const run = indexLock.then(async () => {
    const list = await readIndex();
    const out = await fn(list);
    await writeAtomic(proj().index, JSON.stringify(list, null, 2));
    return out;
  });
  indexLock = run.catch(() => {});
  return run;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function safeName(s, max = 40) {
  return String(s || "").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, max) || "未命名";
}
function kindOf(mime, ext) {
  const m = String(mime || "");
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  const t = MIME[String(ext || "").toLowerCase()] || "";
  return t.startsWith("image/") ? "image" : t.startsWith("video/") ? "video" : t.startsWith("audio/") ? "audio" : "file";
}

/** 生成不重名的文件名：时间_标签_后缀.ext */
async function uniqueFile(label, ext) {
  const dir = proj().assets;
  const base = `${stamp()}_${safeName(label)}`;
  for (let i = 0; i < 1000; i++) {
    const name = `${base}${i ? "_" + i : ""}${ext}`;
    if (!fs.existsSync(path.join(dir, name))) return name;
  }
  return `${base}_${crypto.randomUUID().slice(0, 8)}${ext}`;
}

/* =========================================================
   HTTP 工具
   ========================================================= */
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { reject(httpErr(413, `请求体超过 ${Math.round(limit / 1048576)} MB 上限`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJSON(req, limit = MAX_JSON) {
  const b = await readBody(req, limit);
  if (!b.length) return {};
  try { return JSON.parse(b.toString("utf8")); } catch { throw httpErr(400, "请求体不是合法 JSON"); }
}

/** 带 Range 的文件响应 —— 视频要能拖进度条 */
async function sendFile(req, res, file, { cache = "no-cache", download = false } = {}) {
  let st;
  try { st = await fsp.stat(file); } catch { res.writeHead(404); return res.end("Not found"); }
  if (!st.isFile()) { res.writeHead(404); return res.end("Not found"); }
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": cache,
                    "Last-Modified": st.mtime.toUTCString() };
  if (download) headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    if (!range[1]) end = st.size - 1;
    if (start < 0) start = 0;
    if (start >= st.size || end < start) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end();
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": st.size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

/** 解析出的路径必须仍在 base 目录内 */
function within(base, rel) {
  const p = path.resolve(base, rel);
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

/* =========================================================
   远端下载（生成结果入库）
   签名链接不能加任何额外请求头，否则 TOS 校验失败
   ========================================================= */
function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(httpErr(400, "URL 不合法")); }
    if (!/^https?:$/.test(u.protocol)) return reject(httpErr(400, "只支持 http(s) 链接"));
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(u, { timeout: 120000 }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
        r.resume();
        if (redirects <= 0) return reject(httpErr(502, "跳转次数过多"));
        return resolve(download(new URL(r.headers.location, u).toString(), dest, redirects - 1));
      }
      if (r.statusCode !== 200) {
        let body = "";
        r.setEncoding("utf8");
        r.on("data", (c) => { if (body.length < 600) body += c; });
        r.on("end", () => {
          const hint = r.statusCode === 403 ? "（签名链接可能已过期，有效期 24 小时）" : "";
          reject(httpErr(502, `源地址返回 HTTP ${r.statusCode}${hint}：${body.slice(0, 300)}`));
        });
        return;
      }
      const tmp = dest + ".part";
      const out = fs.createWriteStream(tmp);
      let n = 0;
      r.on("data", (c) => {
        n += c.length;
        if (n > MAX_IMPORT) { r.destroy(httpErr(413, "文件超过 500 MB")); }
      });
      r.on("error", (e) => { out.destroy(); fs.rm(tmp, { force: true }, () => {}); reject(e); });
      out.on("error", (e) => { fs.rm(tmp, { force: true }, () => {}); reject(e); });
      out.on("finish", async () => {
        try { await fsp.rename(tmp, dest); resolve({ size: n, mime: String(r.headers["content-type"] || "").split(";")[0] }); }
        catch (e) { reject(e); }
      });
      r.pipe(out);
    });
    req.on("timeout", () => req.destroy(httpErr(504, "下载超时")));
    req.on("error", reject);
  });
}

function extFromUrl(url) {
  try { return path.extname(new URL(url).pathname).toLowerCase(); } catch { return ""; }
}

/* =========================================================
   原生文件夹选择（macOS），沙箱或非 mac 下会失败，前端退回手动输入
   ========================================================= */
function pickFolder(prompt) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "darwin") return reject(httpErr(501, "原生选择框仅支持 macOS，请手动输入路径"));
    const script = `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`;
    execFile("osascript", ["-e", script], { timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) {
        if (/-128/.test(String(stderr))) return resolve(null);   // 用户点了取消
        return reject(httpErr(501, `无法调起选择框：${String(stderr || err.message).trim().slice(0, 200)}`));
      }
      resolve(stdout.trim().replace(/\/$/, "") || null);
    });
  });
}

function reveal(target) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === "darwin" ? ["open", ["-R", target]]
              : process.platform === "win32" ? ["explorer", [`/select,${target}`]]
              : ["xdg-open", [path.dirname(target)]];
    execFile(cmd[0], cmd[1], (err) => err ? reject(httpErr(501, `无法打开文件管理器：${err.message}`)) : resolve());
  });
}

/* =========================================================
   路由
   ========================================================= */
const STATIC_OK = /^\/(index\.html|favicon\.ico|app\/[\w\-./]+\.(js|css|svg)|lib\/[\w\-./]+\.js)$/;

async function route(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  const p = decodeURIComponent(url.pathname);
  const M = req.method;

  /* ---- 静态 ---- */
  if ((M === "GET" || M === "HEAD") && (p === "/" || STATIC_OK.test(p))) {
    const file = within(APP_ROOT, p === "/" ? "index.html" : p.slice(1));
    if (!file) { res.writeHead(403); return res.end(); }
    return sendFile(req, res, file);
  }

  /* ---- 素材文件 ---- */
  if ((M === "GET" || M === "HEAD") && p.startsWith("/files/")) {
    const file = within(proj().assets, p.slice("/files/".length));
    if (!file || file === proj().assets) { res.writeHead(403); return res.end("Forbidden"); }
    return sendFile(req, res, file, { download: url.searchParams.has("download") });
  }

  if (!p.startsWith("/api/")) { res.writeHead(404); return res.end("Not found"); }

  /* ---- 项目 ---- */
  if (M === "GET" && p === "/api/project") return sendJSON(res, 200, await projectInfo());

  if (M === "GET" && p === "/api/projects/recent") {
    const list = [];
    for (const r of config.recent) list.push({ path: r, name: path.basename(r), exists: await isDir(r) });
    return sendJSON(res, 200, list);
  }

  if (M === "POST" && p === "/api/project/pick") {
    const { mode } = await readJSON(req);
    const prompt = mode === "new"
      ? "选择或新建一个文件夹作为项目（可在对话框里点「新建文件夹」）"
      : "选择一个项目文件夹";
    const dir = await pickFolder(prompt);
    if (!dir) return sendJSON(res, 200, { cancelled: true });
    return sendJSON(res, 200, await openProject(dir));
  }

  if (M === "POST" && p === "/api/project/open") {
    const { path: dir, create } = await readJSON(req);
    if (!dir) throw httpErr(400, "缺少路径");
    if (create) await fsp.mkdir(path.resolve(String(dir).replace(/^~(?=$|\/)/, process.env.HOME || "~")), { recursive: true });
    return sendJSON(res, 200, await openProject(dir));
  }

  if (M === "POST" && p === "/api/project/close") {
    config.current = null; await saveConfig();
    return sendJSON(res, 200, { open: false });
  }

  if (M === "POST" && p === "/api/project/reveal") {
    const { file } = await readJSON(req);
    const target = file ? within(proj().assets, file) : proj().root;
    if (!target) throw httpErr(403, "路径不合法");
    await reveal(target);
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- 画布 ---- */
  if (M === "GET" && p === "/api/canvas") {
    try { return sendJSON(res, 200, JSON.parse(await fsp.readFile(proj().canvas, "utf8"))); }
    catch (e) { if (e.status) throw e; return sendJSON(res, 200, null); }
  }
  if (M === "PUT" && p === "/api/canvas") {
    const target = proj().canvas;   // 先锁定写入目标，防止保存途中切换了项目
    const body = await readBody(req, MAX_JSON);
    try { JSON.parse(body.toString("utf8")); } catch { throw httpErr(400, "画布数据不是合法 JSON"); }
    await writeAtomic(target, body);
    return sendJSON(res, 200, { ok: true, savedAt: Date.now() });
  }

  /* ---- 资源库 ---- */
  if (M === "GET" && p === "/api/library") return sendJSON(res, 200, await readIndex());

  if (M === "POST" && p === "/api/library/upload") {
    const P = proj();
    const name = url.searchParams.get("name") || "upload";
    const mime = String(req.headers["content-type"] || "").split(";")[0];
    const body = await readBody(req, MAX_UPLOAD);
    if (!body.length) throw httpErr(400, "空文件");
    const srcExt = path.extname(name).toLowerCase();
    const ext = MIME[srcExt] ? srcExt : (EXT_BY_MIME[mime] || srcExt || ".bin");
    const kind = url.searchParams.get("kind") || kindOf(mime, ext);
    const file = await uniqueFile("上传_" + path.basename(name, srcExt), ext);
    await fsp.writeFile(path.join(P.assets, file), body);
    const item = {
      id: crypto.randomUUID(), kind, name: path.basename(name, srcExt) || file, file,
      size: body.length, mime: mime || MIME[ext] || "", source: "upload", createdAt: Date.now(),
    };
    for (const k of ["width", "height", "duration"]) {
      const v = Number(url.searchParams.get(k)); if (Number.isFinite(v) && v > 0) item[k] = v;
    }
    await withIndex((list) => { list.unshift(item); });
    return sendJSON(res, 200, item);
  }

  if (M === "POST" && p === "/api/library/import") {
    const P = proj();
    const { url: src, kind: k, name, label, meta } = await readJSON(req);
    if (!src) throw httpErr(400, "缺少 url");
    const guessExt = extFromUrl(src) || (k === "image" ? ".png" : k === "audio" ? ".mp3" : ".mp4");
    const file = await uniqueFile(label || name || "生成", guessExt);
    const dest = path.join(P.assets, file);
    const { size, mime } = await download(src, dest);
    const item = {
      id: crypto.randomUUID(), kind: k || kindOf(mime, guessExt), name: name || label || file, file,
      size, mime: mime || MIME[guessExt] || "", source: "generated", remoteUrl: src, createdAt: Date.now(),
      ...(meta && typeof meta === "object" ? { meta } : {}),
    };
    await withIndex((list) => { list.unshift(item); });
    return sendJSON(res, 200, item);
  }

  const m = /^\/api\/library\/([\w-]+)$/.exec(p);
  if (m && M === "PATCH") {
    const patch = await readJSON(req);
    const out = await withIndex((list) => {
      const it = list.find(x => x.id === m[1]);
      if (!it) throw httpErr(404, "资源不存在");
      for (const k of ["name", "tags", "note", "width", "height", "duration"]) if (k in patch) it[k] = patch[k];
      return it;
    });
    return sendJSON(res, 200, out);
  }
  if (m && M === "DELETE") {
    const P = proj();
    const removed = await withIndex((list) => {
      const i = list.findIndex(x => x.id === m[1]);
      if (i < 0) throw httpErr(404, "资源不存在");
      return list.splice(i, 1)[0];
    });
    const f = within(P.assets, removed.file);
    if (f && f !== P.assets) await fsp.rm(f, { force: true });
    return sendJSON(res, 200, { ok: true });
  }

  throw httpErr(404, `未知接口：${M} ${p}`);
}

/* =========================================================
   启动
   ========================================================= */
await loadConfig();

const server = http.createServer(async (req, res) => {
  try { await route(req, res); }
  catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) sendJSON(res, status, { error: { message: e.message || String(e) } });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Seedance 画布  →  http://${HOST}:${PORT}`);
  console.log(`  当前项目：${config.current || "（未打开，在页面里新建或打开）"}\n`);
});
