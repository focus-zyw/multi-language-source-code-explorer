import type Parser from "web-tree-sitter";
import { createRequire } from "node:module";
import path from "node:path";
import { inspectVueSource, setVueSourceInfo } from "./vue-source.ts";

/**
 * Tree-sitter（WASM）加载器。
 * 语法 wasm 来自 tree-sitter-wasms；所有解析均在本进程内以纯语法分析完成，不执行被分析项目的任何代码。
 */

interface ParserRuntime {
  Parser: typeof Parser;
  initPromise: Promise<void> | null;
  parsers: Map<string, Promise<Parser>>;
}

const globalForParser = globalThis as typeof globalThis & { __codeAtlasParserRuntime?: ParserRuntime };

function getRuntime(): ParserRuntime {
  if (globalForParser.__codeAtlasParserRuntime) return globalForParser.__codeAtlasParserRuntime;
  const nodeRequire = createRequire(path.join(process.cwd(), "package.json"));
  const entry = nodeRequire.resolve("web-tree-sitter");
  let Constructor = nodeRequire("web-tree-sitter") as typeof Parser;
  // 0.22's Emscripten initialization replaces module.exports with its WASM
  // module. A later route bundle / HMR must receive the original constructor.
  // Reload once to recover a process that was already affected before this fix.
  if (typeof Constructor !== "function" || typeof Constructor.init !== "function") {
    delete nodeRequire.cache[entry];
    Constructor = nodeRequire("web-tree-sitter") as typeof Parser;
  }
  const runtime: ParserRuntime = { Parser: Constructor, initPromise: null, parsers: new Map() };
  globalForParser.__codeAtlasParserRuntime = runtime;
  try {
    runtime.initPromise = Constructor.init({
      locateFile: (name: string) => path.join(wasmRoot(), "web-tree-sitter", name),
    }).catch((error: unknown) => {
      if (globalForParser.__codeAtlasParserRuntime === runtime) {
        delete globalForParser.__codeAtlasParserRuntime;
        delete nodeRequire.cache[entry];
      }
      throw error;
    });
  } catch (error) {
    delete globalForParser.__codeAtlasParserRuntime;
    throw error;
  } finally {
    const cached = nodeRequire.cache[entry];
    if (cached) cached.exports = Constructor;
  }
  return runtime;
}

function wasmRoot(): string {
  return process.env.TREE_SITTER_WASM_ROOT || path.join(process.cwd(), "node_modules");
}

export function getParser(grammar: string): Promise<Parser> {
  const runtime = getRuntime();
  let p = runtime.parsers.get(grammar);
  if (!p) {
    p = (async () => {
      await runtime.initPromise;
      const lang = await runtime.Parser.Language.load(path.join(wasmRoot(), "tree-sitter-wasms", "out", `tree-sitter-${grammar}.wasm`));
      const parser = new runtime.Parser();
      parser.setLanguage(lang);
      // 防止病态输入长时间占用 CPU（微秒）
      parser.setTimeoutMicros(8_000_000);
      return parser;
    })();
    p.catch(() => runtime.parsers.delete(grammar));
    runtime.parsers.set(grammar, p);
  }
  return p;
}

/** 解析源码；调用方必须在使用完毕后调用 tree.delete() 释放 WASM 内存 */
export async function parseSource(grammar: string, source: string): Promise<Parser.Tree | null> {
  const parser = await getParser(grammar);
  let tree: Parser.Tree | null;
  try {
    tree = parser.parse(source);
  } catch {
    parser.reset();
    return null;
  }
  if (grammar !== "vue" || !tree) return tree;
  let info;
  try { info = inspectVueSource(tree.rootNode, source); }
  finally { tree.delete(); }
  const scriptTree = await parseSource(info.grammar, info.scriptSource);
  if (scriptTree) setVueSourceInfo(scriptTree, info);
  return scriptTree;
}
