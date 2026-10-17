import type { ParamInfo, SymbolMetrics } from "./types.ts";

export interface StaticSummary {
  headline: string;
  bullets: string[];
  /** 说明：该摘要完全由静态分析事实生成，不含模型推测 */
  source: "static";
}

export interface SummaryInput {
  kind: "function" | "method" | "class" | "test" | "element" | "property";
  name: string;
  qualifiedName: string;
  signature: string;
  params: ParamInfo[];
  decorators: string[];
  docstring: string | null;
  returnType: string | null;
  bases: string[];
  isAsync: boolean;
  isGenerator: boolean;
  startLine: number;
  endLine: number;
  metrics: SymbolMetrics;
  filePath: string;
  childCount: number;
  calls: { callee: string; resolution: string; targetName: string | null }[];
  testCount: number;
}

const KIND_LABEL = { function: "函数", method: "方法", class: "类", test: "测试用例", element: "HTML 节点", property: "JSON 节点" } as const;

export function buildStaticSummary(i: SummaryInput): StaticSummary {
  const m = i.metrics;
  const doc = i.docstring ? i.docstring.split("\n").find((l) => l.trim() && !l.trim().startsWith("@")) ?? null : null;
  const label = KIND_LABEL[i.kind];
  const flags = [i.isAsync ? "异步" : "", i.isGenerator ? "生成器" : ""].filter(Boolean).join("、");
  const headline = doc
    ? `${flags ? flags + " " : ""}${label} ${i.qualifiedName}：${doc.trim().replace(/[。.]$/, "")}。`
    : `${flags ? flags + " " : ""}${label} ${i.qualifiedName}，位于 ${i.filePath} 第 ${i.startLine}–${i.endLine} 行。`;

  const bullets: string[] = [];
  bullets.push(`签名：${i.signature}`);
  if (i.decorators.length) bullets.push(`装饰器/注解：${i.decorators.join("、")}`);

  if ((i.kind === "element" || i.kind === "property")) {
    bullets.push(`直接子节点 ${i.childCount} 个；范围 ${m.loc} 行。`);
    bullets.push("父子节点表示文档包含关系；不计算圈复杂度、变量或调用流程。");
    return { headline, bullets, source: "static" };
  }

  if (i.kind === "class") {
    bullets.push(i.bases.length ? `继承：${i.bases.join("、")}` : "未声明基类");
    bullets.push(`包含 ${i.childCount} 个可浏览的方法/成员函数，共 ${m.loc} 行。`);
    return { headline, bullets, source: "static" };
  }

  if (i.params.length) {
    const shown = i.params.slice(0, 8).map((p) => p.display);
    bullets.push(`参数 ${i.params.length} 个：${shown.join("，")}${i.params.length > 8 ? " …" : ""}`);
  } else bullets.push("无参数");
  if (i.returnType) bullets.push(`声明的返回类型：${i.returnType}`);

  const level = m.complexity <= 5 ? "较简单" : m.complexity <= 10 ? "中等" : "较复杂";
  bullets.push(
    `规模：${m.loc} 行；圈复杂度 ${m.complexity}（${level}）= 1 + 分支 ${m.branches} + 循环 ${m.loops} + 异常处理 ${m.handlers} + 布尔运算 ${m.booleanOps}`,
  );
  const flow: string[] = [];
  flow.push(m.returns ? `${m.returns} 处 return` : "无显式 return");
  if (m.throws) flow.push(`${m.throws} 处主动抛出异常`);
  if (m.awaits) flow.push(`${m.awaits} 处 await`);
  bullets.push(`控制流：${flow.join("，")}`);

  if (i.calls.length) {
    const c: Record<string, number> = { exact: 0, inferred: 0, heuristic: 0, external: 0, unresolved: 0 };
    for (const call of i.calls) c[call.resolution] = (c[call.resolution] ?? 0) + 1;
    const parts: string[] = [];
    if (c.exact) parts.push(`${c.exact} 处确定指向项目内代码`);
    if (c.inferred) parts.push(`${c.inferred} 处为推断`);
    if (c.heuristic) parts.push(`${c.heuristic} 处仅有猜测候选`);
    if (c.external) parts.push(`${c.external} 处为外部/内建`);
    if (c.unresolved) parts.push(`${c.unresolved} 处无法解析`);
    bullets.push(`共 ${i.calls.length} 处调用：${parts.join("，")}`);
    const named = i.calls.filter((x) => x.resolution === "exact" || x.resolution === "inferred").slice(0, 6);
    if (named.length) bullets.push(`主要调用的项目内方法：${[...new Set(named.map((x) => x.targetName ?? x.callee))].join("、")}`);
  } else bullets.push("方法体内没有函数调用。");

  if (i.kind === "test") bullets.push("这是一个测试用例；其“被测对象”见「关联测试」页签（含可信度）。");
  else bullets.push(i.testCount ? `静态匹配到 ${i.testCount} 个关联测试（含推测，见「关联测试」页签）` : "未匹配到关联测试（不代表没有测试）。");
  return { headline, bullets, source: "static" };
}
