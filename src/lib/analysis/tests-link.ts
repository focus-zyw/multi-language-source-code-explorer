import type { FileUnit, ResolvedRef, SymRec } from "./resolve.ts";

export type TestLinkMethod = "direct-call" | "indirect-call" | "name-match";
export type TestLinkConfidence = "exact" | "inferred" | "indirect" | "heuristic";

export interface TestLinkOut {
  testSymbolId: number;
  targetSymbolId: number;
  method: TestLinkMethod;
  confidence: TestLinkConfidence;
  score: number;
  reason: string;
  viaSymbolId: number | null;
}

const GENERIC = new Set(["get", "set", "run", "main", "init", "test", "setup", "teardown", "call", "handle", "add", "update", "create", "delete", "render", "start", "stop", "load", "save", "constructor", "default", "should", "work", "works"]);

function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

function stemOf(path: string): string {
  const base = (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");
  return base
    .toLowerCase()
    .replace(/^test_?/, "")
    .replace(/_?tests?$/, "")
    .replace(/\.(test|spec)$/, "")
    .replace(/[^a-z0-9]/g, "");
}

export function linkTests(files: FileUnit[], symbolIds: number[][], refs: ResolvedRef[]): TestLinkOut[] {
  const all: SymRec[] = [];
  for (const f of files) for (const sym of f.extract.symbols) all.push({ id: symbolIds[f.idx][sym.localId], fileIdx: f.idx, sym });
  const byId = new Map(all.map((r) => [r.id, r]));
  const tests = all.filter((r) => r.sym.kind === "test");
  if (!tests.length) return [];

  const isUnderTest = (r: SymRec) => files[r.fileIdx].isTest;
  const refsByOwner = new Map<number, ResolvedRef[]>();
  for (const r of refs) {
    const l = refsByOwner.get(r.ownerSymbolId);
    if (l) l.push(r);
    else refsByOwner.set(r.ownerSymbolId, [r]);
  }

  const links = new Map<string, TestLinkOut>();
  const RANK: Record<TestLinkConfidence, number> = { exact: 4, inferred: 3, indirect: 2, heuristic: 1 };
  const put = (l: TestLinkOut) => {
    const key = `${l.testSymbolId}>${l.targetSymbolId}`;
    const prev = links.get(key);
    if (!prev || RANK[l.confidence] > RANK[prev.confidence] || (RANK[l.confidence] === RANK[prev.confidence] && l.score > prev.score)) links.set(key, l);
  };

  // 1. 直接调用
  const strongTargets = new Map<number, Set<number>>();
  for (const t of tests) {
    for (const ref of refsByOwner.get(t.id) ?? []) {
      for (const tg of ref.targets) {
        const target = byId.get(tg.symbolId);
        if (!target || isUnderTest(target) || target.sym.kind === "test") continue;
        if (tg.confidence === "exact" || tg.confidence === "inferred") {
          put({
            testSymbolId: t.id,
            targetSymbolId: tg.symbolId,
            method: "direct-call",
            confidence: tg.confidence,
            score: tg.score,
            reason: `测试在第 ${ref.call.line} 行调用 ${ref.call.calleeText}：${ref.reason}`,
            viaSymbolId: null,
          });
          let s = strongTargets.get(t.id);
          if (!s) strongTargets.set(t.id, (s = new Set()));
          s.add(tg.symbolId);
        } else {
          put({
            testSymbolId: t.id,
            targetSymbolId: tg.symbolId,
            method: "direct-call",
            confidence: "heuristic",
            score: Math.round(tg.score * 0.8 * 100) / 100,
            reason: `测试在第 ${ref.call.line} 行调用 ${ref.call.calleeText}，仅按名称匹配到该候选（未验证）`,
            viaSymbolId: null,
          });
        }
      }
    }
  }

  // 2. 间接调用（测试 → A → B），仅沿确定/推断的调用边展开一层
  for (const t of tests) {
    const direct = strongTargets.get(t.id);
    if (!direct) continue;
    let added = 0;
    for (const viaId of direct) {
      for (const ref of refsByOwner.get(viaId) ?? []) {
        for (const tg of ref.targets) {
          if (added >= 15) break;
          if (tg.confidence === "heuristic" || tg.symbolId === viaId) continue;
          const target = byId.get(tg.symbolId);
          if (!target || isUnderTest(target) || target.sym.kind === "test") continue;
          if (links.has(`${t.id}>${tg.symbolId}`)) continue;
          const via = byId.get(viaId)!;
          put({
            testSymbolId: t.id,
            targetSymbolId: tg.symbolId,
            method: "indirect-call",
            confidence: "indirect",
            score: 0.5,
            reason: `间接：测试直接调用 ${via.sym.qualifiedName}，后者调用了本方法（第 ${ref.call.line} 行）`,
            viaSymbolId: viaId,
          });
          added++;
        }
      }
    }
  }

  // 3. 名称/文件名启发式（仅对没有确定直接调用的测试）
  const targetsByNorm = new Map<string, SymRec[]>();
  for (const r of all) {
    if (r.sym.kind === "test" || isUnderTest(r)) continue;
    if (r.sym.kind === "function" && r.sym.parentLocalId !== null) continue;
    const norm = tokens(r.sym.name).join("_");
    if (!norm) continue;
    const l = targetsByNorm.get(norm);
    if (l) l.push(r);
    else targetsByNorm.set(norm, [r]);
  }
  for (const t of tests) {
    if (strongTargets.has(t.id)) continue;
    const testStem = stemOf(files[t.fileIdx].path);
    const found = new Map<number, { rec: SymRec; score: number; reason: string }>();
    const scan = (text: string, origin: string) => {
      const tk = tokens(text);
      for (let len = Math.min(5, tk.length); len >= 1; len--) {
        for (let i = 0; i + len <= tk.length; i++) {
          const gram = tk.slice(i, i + len).join("_");
          for (const cand of targetsByNorm.get(gram) ?? []) {
            if (len === 1 && (gram.length < 4 || GENERIC.has(gram))) continue;
            let score = 0.35 + (len > 1 ? 0.1 : 0);
            const bits = [`${origin}包含名称「${cand.sym.name}」`];
            const candStem = (files[cand.fileIdx].path.split("/").pop() ?? "").replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
            if (testStem && candStem && (testStem === candStem || candStem.includes(testStem) || testStem.includes(candStem))) {
              score += 0.25;
              bits.push(`测试文件名与 ${files[cand.fileIdx].path} 相近`);
            }
            if (cand.sym.kind === "class") score += 0.05;
            score = Math.min(0.8, Math.round(score * 100) / 100);
            const prev = found.get(cand.id);
            if (!prev || prev.score < score) found.set(cand.id, { rec: cand, score, reason: bits.join("；") });
          }
        }
      }
    };
    scan(t.sym.name, "测试名");
    if (t.sym.container) scan(t.sym.container, "所属测试组/类名");
    const top = [...found.values()].filter((f) => f.score >= 0.45).sort((a, b) => b.score - a.score).slice(0, 3);
    for (const f of top) {
      put({
        testSymbolId: t.id,
        targetSymbolId: f.rec.id,
        method: "name-match",
        confidence: "heuristic",
        score: f.score,
        reason: `${f.reason}（命名启发式，未验证调用关系）`,
        viaSymbolId: null,
      });
    }
  }

  return [...links.values()];
}
