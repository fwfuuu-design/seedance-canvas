/* =========================================================================
   资源库：当前项目的 assets/ + assets.json
   ========================================================================= */
import { api, fileUrl } from "./ui.js";

export const lib = { items: [], loaded: false };
const listeners = new Set();
export function onLibChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn(); }

export async function refresh() {
  try { lib.items = await api("/api/library"); }
  catch { lib.items = []; }
  lib.loaded = true;
  emit();
  return lib.items;
}

export function byId(id) { return lib.items.find(x => x.id === id); }

export function kindOfFile(file) {
  const t = file.type || "";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "heic", "heif"].includes(ext)) return "image";
  if (["mp4", "mov", "webm"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg"].includes(ext)) return "audio";
  return null;
}

/** 读媒体尺寸 / 时长，入库时一并记下 */
function probe(file, kind) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
    if (kind === "image") {
      const img = new Image();
      img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => done({});
      img.src = url;
    } else if (kind === "video" || kind === "audio") {
      const el = document.createElement(kind);
      el.preload = "metadata";
      el.onloadedmetadata = () => done({ width: el.videoWidth || undefined, height: el.videoHeight || undefined,
                                         duration: Number.isFinite(el.duration) ? +el.duration.toFixed(2) : undefined });
      el.onerror = () => done({});
      el.src = url;
    } else done({});
    setTimeout(() => done({}), 5000);
  });
}

export async function upload(file) {
  const kind = kindOfFile(file);
  if (!kind) throw new Error(`${file.name}：不支持的文件类型`);
  if (file.size > 100 * 1024 * 1024) throw new Error(`${file.name}：超过 100 MB`);
  const meta = await probe(file, kind);
  const q = new URLSearchParams({ name: file.name, kind });
  for (const [k, v] of Object.entries(meta)) if (v) q.set(k, v);
  const item = await api("/api/library/upload?" + q, { method: "POST", body: file, raw: true, type: file.type || "application/octet-stream" });
  lib.items.unshift(item);
  emit();
  return item;
}

/** 远端结果入库（服务端下载） */
export async function importRemote(url, kind, name, label, meta) {
  const item = await api("/api/library/import", { method: "POST", body: { url, kind, name, label, meta } });
  lib.items.unshift(item);
  emit();
  return item;
}

export async function remove(id) {
  await api("/api/library/" + id, { method: "DELETE" });
  lib.items = lib.items.filter(x => x.id !== id);
  emit();
}

export async function rename(id, name) {
  const it = await api("/api/library/" + id, { method: "PATCH", body: { name } });
  const i = lib.items.findIndex(x => x.id === id);
  if (i >= 0) lib.items[i] = it;
  emit();
}

export async function reveal(file) {
  await api("/api/project/reveal", { method: "POST", body: file ? { file } : {} });
}

/* =========================================================
   送给网关前的素材转换
   图片：长边 > 2048 先压成 JPEG，再转 base64
   ========================================================= */
const MAX_EDGE = 2048;

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

export async function imageDataUrl(file) {
  const blob = await (await fetch(fileUrl(file))).blob();
  const bmp = await createImageBitmap(blob).catch(() => null);
  if (!bmp) return blobToDataUrl(blob);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  // 小图且格式本身就是方舟支持的，原样发送
  if (scale === 1 && /image\/(png|jpeg|webp)/.test(blob.type) && blob.size < 4 * 1024 * 1024) {
    bmp.close?.();
    return blobToDataUrl(blob);
  }
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL("image/jpeg", 0.9);
}

export async function audioDataUrl(file) {
  const blob = await (await fetch(fileUrl(file))).blob();
  if (blob.size > 15 * 1024 * 1024) throw new Error("参考音频超过 15 MB");
  return blobToDataUrl(blob);
}
