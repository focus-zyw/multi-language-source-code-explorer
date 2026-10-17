import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { LocalFolderListing } from "../api-types.ts";
import { ImportError, LIMITS } from "./rules.ts";

/** Lists directory names only; no source file content is read while browsing. */
export async function listLocalFolders(requested?: string): Promise<LocalFolderListing> {
  const raw = (requested || process.cwd()).trim().replace(/^"(.*)"$/, "$1");
  if (!path.isAbsolute(raw) || /[\x00-\x1f]/.test(raw)) throw new ImportError("请输入有效的本机文件夹绝对路径");
  if (/^(?:\\\\|\/\/)/.test(raw)) throw new ImportError("暂不支持浏览网络共享路径");
  let root: string;
  try {
    root = await realpath(/* turbopackIgnore: true */ raw);
    if (!(await stat(/* turbopackIgnore: true */ root)).isDirectory()) throw new ImportError("该路径不是文件夹");
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("文件夹不存在或无法访问，请选择其他位置", 422);
  }
  const folders: LocalFolderListing["folders"] = [];
  let entries = 0;
  let truncated = false;
  try {
    const directory = await opendir(/* turbopackIgnore: true */ root);
    for await (const item of directory) {
      if (++entries > LIMITS.maxEntries) { truncated = true; break; }
      if (!item.isDirectory() || item.isSymbolicLink()) continue;
      if (folders.length >= 500) { truncated = true; break; }
      folders.push({ name: item.name, path: path.join(/* turbopackIgnore: true */ root, item.name) });
    }
  } catch {
    throw new ImportError("无法浏览该文件夹，请检查读取权限或选择其他位置", 422);
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  const parent = path.dirname(root);
  const shortcuts = [{ name: "应用目录", path: process.cwd() }, { name: "用户目录", path: homedir() }];
  const drives = new Set([root, process.cwd(), homedir()].map((value) => path.parse(value).root));
  for (const drive of drives) shortcuts.push({ name: process.platform === "win32" ? `磁盘 ${drive.slice(0, 2)}` : "文件系统", path: drive });
  return { path: root, parent: parent === root ? null : parent, folders, shortcuts, truncated };
}
