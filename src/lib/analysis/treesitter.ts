import Parser from "web-tree-sitter";
import path from "node:path";

/**
 * Tree-sitter（WASM）加载器。
 * 语法 wasm 来自 tree-sitter-wasms；所有解析均在本进程内以纯语法分析完成，不执行被分析项目的任何代码。
 */

let initPromise: Promise<void> | null = null;
const parsers = new Map<string, Promise<Parser>>();

function wasmRoot(): string {
  return process.env.TREE_SITTER_WASM_ROOT || path.join(process.cwd(), "node_modules");
}

function init(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({
      locateFile: (name: string) => path.join(wasmRoot(), "web-tree-sitter", name),
    });
  }
  return initPromise;
}

export function getParser(grammar: string): Promise<Parser> {
  let p = parsers.get(grammar);
  if (!p) {
    p = (async () => {
      await init();
      const lang = await Parser.Language.load(path.join(wasmRoot(), "tree-sitter-wasms", "out", `tree-sitter-${grammar}.wasm`));
      const parser = new Parser();
      parser.setLanguage(lang);
      // 防止病态输入长时间占用 CPU（微秒）
      parser.setTimeoutMicros(8_000_000);
      return parser;
    })();
    p.catch(() => parsers.delete(grammar));
    parsers.set(grammar, p);
  }
  return p;
}

/** 解析源码；调用方必须在使用完毕后调用 tree.delete() 释放 WASM 内存 */
export async function parseSource(grammar: string, source: string): Promise<Parser.Tree | null> {
  const parser = await getParser(grammar);
  try {
    return parser.parse(source);
  } catch {
    parser.reset();
    return null;
  }
}
