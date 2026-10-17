import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { SkipRecord } from "../shared.ts";
import { classifyPath, IGNORED_DIRS, ImportError, LIMITS, normalizeEntryPath } from "./rules.ts";
import type { RawFile } from "./zip.ts";

export interface LocalCollection {
  sourcePath: string;
  rootName: string;
  files: RawFile[];
  fileCount: number;
  totalBytes: number;
  samplePaths: string[];
  skipped: SkipRecord[];
  warnings: string[];
}

function isInside(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Reads only the chosen directory. Nested symlinks/junctions are never traversed. */
export async function collectLocalDirectory(raw: string, preview = false): Promise<LocalCollection> {
  const requested = raw.trim().replace(/^"(.*)"$/, "$1");
  if (!requested || /[\x00-\x1f]/.test(requested) || !path.isAbsolute(requested)) {
    throw new ImportError("请输入有效的本机绝对路径，例如 D:\\projects\\my-app");
  }
  if (/^(?:\\\\|\/\/)/.test(requested)) throw new ImportError("请选择本机目录，暂不支持网络共享路径");
  let root: string;
  try {
    root = await realpath(/* turbopackIgnore: true */ requested);
    if (!(await stat(/* turbopackIgnore: true */ root)).isDirectory()) throw new ImportError("该路径不是文件夹");
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("目录不存在或无法访问，请检查路径和读取权限", 422);
  }
  if (root === path.parse(root).root) throw new ImportError("请选择具体项目目录，不能扫描整个磁盘根目录");
  const result: LocalCollection = { sourcePath: root, rootName: path.basename(root), files: [], fileCount: 0, totalBytes: 0, samplePaths: [], skipped: [], warnings: [] };
  let entries = 0;
  const readBuffer = preview ? null : Buffer.alloc(LIMITS.maxFileBytes + 1);
  const skip = (filename: string, reason: string) => result.skipped.push({ path: filename, reason });

  async function walk(directory: string, prefix: string): Promise<void> {
    const canonical = await realpath(/* turbopackIgnore: true */ directory);
    if (!isInside(root, canonical)) throw new ImportError("扫描目录发生变化，请重试", 409);
    const dir = await opendir(/* turbopackIgnore: true */ directory);
    for await (const entry of dir) {
      if (++entries > LIMITS.maxEntries) throw new ImportError(`目录条目数超过上限 ${LIMITS.maxEntries}，请选择更小的项目目录`, 413);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const check = normalizeEntryPath(relative);
      if (!check.ok) { skip(relative.slice(0, 200), check.reason); continue; }
      const full = path.join(/* turbopackIgnore: true */ directory, entry.name);
      const info = await lstat(/* turbopackIgnore: true */ full);
      if (info.isSymbolicLink()) { skip(relative, "symlink"); continue; }
      if (info.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || IGNORED_DIRS.has(entry.name.toLowerCase())) { skip(relative, "ignored-dir"); continue; }
        await walk(full, relative);
        continue;
      }
      if (!info.isFile()) { skip(relative, "special-file"); continue; }
      const reason = classifyPath(relative);
      if (reason) { skip(relative, reason); continue; }
      if (info.size > LIMITS.maxFileBytes) { skip(relative, "too-large"); continue; }
      if (result.fileCount >= LIMITS.maxAnalyzedFiles) { skip(relative, "file-limit"); continue; }
      if (result.totalBytes + info.size > LIMITS.maxTotalReadBytes) { skip(relative, "total-limit"); continue; }
      const target = await realpath(/* turbopackIgnore: true */ full);
      if (!isInside(root, target)) throw new ImportError("文件路径发生变化，请重试扫描", 409);
      let size = info.size;
      let data: Buffer | undefined;
      if (!preview) {
        const handle = await open(/* turbopackIgnore: true */ full, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
        try {
          if (!(await handle.stat()).isFile() || !isInside(root, await realpath(/* turbopackIgnore: true */ full))) {
            throw new ImportError("文件类型或路径发生变化，请重试扫描", 409);
          }
          const buffer = readBuffer!;
          let read = 0;
          while (read < buffer.length) {
            const part = await handle.read(buffer, read, buffer.length - read, read);
            if (!part.bytesRead) break;
            read += part.bytesRead;
          }
          if (read > LIMITS.maxFileBytes) { skip(relative, "too-large"); continue; }
          data = Buffer.from(buffer.subarray(0, read));
          size = read;
        } finally { await handle.close(); }
      }
      if (result.totalBytes + size > LIMITS.maxTotalReadBytes) { skip(relative, "total-limit"); continue; }
      result.totalBytes += size;
      result.fileCount++;
      if (result.samplePaths.length < 12) result.samplePaths.push(relative);
      if (data) result.files.push({ path: relative, data });
    }
  }
  try { await walk(root, ""); }
  catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("扫描中有文件或目录无法读取，请检查权限或待文件操作完成后重试；原有分析不会被覆盖", 422);
  }
  result.files.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}
