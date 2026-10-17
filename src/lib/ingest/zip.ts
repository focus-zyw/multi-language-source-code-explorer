import yauzl from "yauzl";
import type { SkipRecord } from "../shared.ts";
import { ImportError, LIMITS, classifyPath, commonRoot, normalizeEntryPath } from "./rules.ts";

export interface RawFile {
  path: string;
  data: Buffer;
}

export interface CollectResult {
  files: RawFile[];
  skipped: SkipRecord[];
  warnings: string[];
  rootName: string | null;
}

class TooLargeError extends Error {}

/**
 * 安全读取 ZIP：
 *  - 全程在内存中处理，不向磁盘写入任何解压内容 → 不存在“写到目录之外”的风险；
 *  - 仍对每个条目做路径校验，拒绝穿越/绝对路径/控制字符，并如实记录；
 *  - 忽略符号链接、加密条目；仅读取受支持语言的源码条目（其余条目根本不解压）；
 *  - 限制条目数、单文件大小、总读取字节数，并对异常压缩比的条目拒绝解压（防 ZIP 炸弹）；
 *  - 解压时按“实际读取的字节”计数，而不是信任 ZIP 头中声明的大小。
 */
export async function collectFromZip(buf: Buffer): Promise<CollectResult> {
  if (buf.length > LIMITS.maxZipBytes) throw new ImportError("ZIP 文件超过大小上限（100MB）", 413);
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, decodeStrings: false, validateEntrySizes: true }, (err, z) => {
      if (err || !z) reject(new ImportError(`无法读取 ZIP：${err?.message ?? "未知错误"}`));
      else resolve(z);
    });
  });
  try {
    if (zip.entryCount > LIMITS.maxEntries) throw new ImportError(`ZIP 条目数（${zip.entryCount}）超过上限 ${LIMITS.maxEntries}`);
    const entries = await listEntries(zip);

    const skipped: SkipRecord[] = [];
    const warnings: string[] = [];
    const valid: { entry: yauzl.Entry; path: string }[] = [];

    for (const e of entries) {
      const rawName = Buffer.isBuffer(e.fileName) ? e.fileName.toString("utf8") : String(e.fileName);
      if (rawName.endsWith("/") || rawName.endsWith("\\")) continue; // 目录条目
      const check = normalizeEntryPath(rawName);
      if (!check.ok) {
        skipped.push({ path: rawName.slice(0, 200), reason: check.reason });
        continue;
      }
      const mode = (e.externalFileAttributes >>> 16) & 0xffff;
      if ((mode & 0o170000) === 0o120000) {
        skipped.push({ path: check.path, reason: "symlink" });
        continue;
      }
      valid.push({ entry: e, path: check.path });
    }
    const traversal = skipped.filter((s) => s.reason === "path-traversal" || s.reason === "absolute-path").length;
    if (traversal) warnings.push(`ZIP 中有 ${traversal} 个条目使用了穿越/绝对路径，已全部拒绝。`);

    const root = commonRoot(valid.map((v) => v.path));
    const candidates: { entry: yauzl.Entry; path: string }[] = [];
    const seen = new Set<string>();
    for (const v of valid) {
      const p = root ? v.path.slice(root.length + 1) : v.path;
      const reason = classifyPath(p);
      if (reason) {
        skipped.push({ path: p, reason });
        continue;
      }
      if (v.entry.isEncrypted()) {
        skipped.push({ path: p, reason: "encrypted" });
        continue;
      }
      const declared = v.entry.uncompressedSize;
      if (declared > LIMITS.maxFileBytes) {
        skipped.push({ path: p, reason: "too-large" });
        continue;
      }
      if (declared > 65_536 && v.entry.compressedSize > 0 && declared / v.entry.compressedSize > LIMITS.maxCompressionRatio) {
        skipped.push({ path: p, reason: "suspicious-ratio" });
        continue;
      }
      if (seen.has(p)) {
        skipped.push({ path: p, reason: "duplicate" });
        continue;
      }
      if (candidates.length >= LIMITS.maxAnalyzedFiles) {
        skipped.push({ path: p, reason: "file-limit" });
        continue;
      }
      seen.add(p);
      candidates.push({ entry: v.entry, path: p });
    }

    const files: RawFile[] = [];
    let total = 0;
    for (const c of candidates) {
      if (total > LIMITS.maxTotalReadBytes) {
        skipped.push({ path: c.path, reason: "total-limit" });
        continue;
      }
      try {
        const data = await readEntry(zip, c.entry, LIMITS.maxFileBytes);
        total += data.length;
        files.push({ path: c.path, data });
      } catch (err) {
        skipped.push({ path: c.path, reason: err instanceof TooLargeError ? "too-large" : "unsupported-compression" });
      }
    }
    return { files, skipped, warnings, rootName: root };
  } finally {
    zip.close();
  }
}

function listEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const list: yauzl.Entry[] = [];
    zip.on("entry", (e: yauzl.Entry) => {
      list.push(e);
      if (list.length > LIMITS.maxEntries) {
        reject(new ImportError("ZIP 条目数超过上限"));
        return;
      }
      zip.readEntry();
    });
    zip.once("end", () => resolve(list));
    zip.once("error", (e: Error) => reject(new ImportError(`ZIP 解析失败：${e.message}`)));
    zip.readEntry();
  });
}

function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error("no stream"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      stream.on("data", (ch: Buffer) => {
        if (done) return;
        size += ch.length;
        if (size > max) {
          done = true;
          stream.destroy();
          reject(new TooLargeError());
          return;
        }
        chunks.push(ch);
      });
      stream.once("end", () => {
        if (!done) {
          done = true;
          resolve(Buffer.concat(chunks));
        }
      });
      stream.once("error", (e: Error) => {
        if (!done) {
          done = true;
          reject(e);
        }
      });
    });
  });
}

export interface UploadItem {
  rawPath: string;
  size: number;
  read: () => Promise<Buffer>;
}

/** 文件夹上传：与 ZIP 使用同一套路径校验与过滤规则（服务端强制，不信任前端预过滤） */
export async function collectFromUploads(items: UploadItem[]): Promise<CollectResult> {
  const skipped: SkipRecord[] = [];
  const warnings: string[] = [];
  const valid: { item: UploadItem; path: string }[] = [];
  for (const item of items) {
    const check = normalizeEntryPath(item.rawPath);
    if (!check.ok) {
      skipped.push({ path: item.rawPath.slice(0, 200), reason: check.reason });
      continue;
    }
    valid.push({ item, path: check.path });
  }
  const traversal = skipped.filter((s) => s.reason === "path-traversal" || s.reason === "absolute-path").length;
  if (traversal) warnings.push(`上传中有 ${traversal} 个文件使用了穿越/绝对路径，已全部拒绝。`);
  const root = commonRoot(valid.map((v) => v.path));
  const files: RawFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const v of valid) {
    const p = root ? v.path.slice(root.length + 1) : v.path;
    const reason = classifyPath(p);
    if (reason) {
      skipped.push({ path: p, reason });
      continue;
    }
    if (v.item.size > LIMITS.maxFileBytes) {
      skipped.push({ path: p, reason: "too-large" });
      continue;
    }
    if (seen.has(p)) {
      skipped.push({ path: p, reason: "duplicate" });
      continue;
    }
    if (files.length >= LIMITS.maxAnalyzedFiles) {
      skipped.push({ path: p, reason: "file-limit" });
      continue;
    }
    if (total > LIMITS.maxTotalReadBytes) {
      skipped.push({ path: p, reason: "total-limit" });
      continue;
    }
    const data = await v.item.read();
    if (data.length > LIMITS.maxFileBytes) {
      skipped.push({ path: p, reason: "too-large" });
      continue;
    }
    total += data.length;
    seen.add(p);
    files.push({ path: p, data });
  }
  return { files, skipped, warnings, rootName: root };
}
