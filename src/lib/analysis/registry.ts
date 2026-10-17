import type { LanguagePlugin } from "./types.ts";
import { pythonPlugin } from "./lang/python.ts";
import { javascriptPlugin, typescriptPlugin } from "./lang/javascript.ts";
import { goPlugin } from "./lang/go.ts";

/**
 * 语言插件注册表。新增语言只需：
 *  1. 实现 LanguagePlugin（extract / flowIR / analyzeVariables / resolveImport）
 *  2. 在此注册，并确保 tree-sitter-wasms 中存在对应 grammar
 */
export const plugins: LanguagePlugin[] = [pythonPlugin, javascriptPlugin, typescriptPlugin, goPlugin];

export function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
}

export function pluginForPath(path: string): { plugin: LanguagePlugin; ext: string; grammar: string } | null {
  const ext = extensionOf(path);
  for (const plugin of plugins) {
    if (plugin.extensions.includes(ext)) return { plugin, ext, grammar: plugin.grammarFor(ext) };
  }
  return null;
}

export function pluginById(id: string): LanguagePlugin | null {
  return plugins.find((p) => p.id === id) ?? null;
}

export const supportedExtensions: string[] = plugins.flatMap((p) => p.extensions);
