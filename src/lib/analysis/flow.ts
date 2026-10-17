import type { FlowEdge, FlowGraph, FlowNode, FlowNodeKind, IRStmt } from "./types.ts";

interface Exit {
  from: string;
  label?: string;
  kind?: FlowEdge["kind"];
}

interface LoopCtx {
  breakExits: Exit[] | null;
  continueTarget: string | null;
}

/**
 * 将语言无关的结构化 IR 转换为流程图（节点 + 有向边）。
 * 简化说明：finally 不会绘制 return/throw 经过 finally 的路径；回调函数 / lambda 内部逻辑不展开。
 */
export function buildFlowGraph(ir: IRStmt[], title: string, startLine: number, endLine: number, maxNodes = 150): FlowGraph {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let truncated = false;
  let counter = 0;

  const add = (kind: FlowNodeKind, label: string, sl: number, el: number, calls: string[] = []): FlowNode => {
    const n: FlowNode = { id: `n${counter++}`, kind, label, startLine: sl, endLine: el, calls };
    nodes.push(n);
    return n;
  };
  const link = (from: string, to: string, label?: string, kind: FlowEdge["kind"] = "normal") => {
    edges.push({ id: `e${edges.length}`, source: from, target: to, label, kind });
  };
  const connect = (preds: Exit[], to: string) => {
    for (const p of preds) link(p.from, to, p.label, p.kind ?? "normal");
  };

  const start = add("start", title, startLine, startLine);
  const END_ID = "end";

  interface Run {
    node: FlowNode;
    count: number;
  }

  const seq = (stmts: IRStmt[], preds: Exit[], ctx: LoopCtx): { entry: string | null; exits: Exit[] } => {
    let entry: string | null = null;
    let cur = preds;
    let run: Run | null = null;
    const enter = (n: FlowNode) => {
      connect(cur, n.id);
      if (entry === null) entry = n.id;
    };

    for (const s of stmts) {
      if (nodes.length >= maxNodes) {
        truncated = true;
        break;
      }
      if (s.t !== "stmt") run = null;
      switch (s.t) {
        case "stmt": {
          if (run && run.count < 4) {
            run.node.label += `\n${s.label}`;
            run.node.endLine = s.endLine;
            run.count++;
            for (const c of s.calls) if (!run.node.calls.includes(c) && run.node.calls.length < 5) run.node.calls.push(c);
          } else {
            const n = add("process", s.label, s.startLine, s.endLine, s.calls.slice());
            enter(n);
            cur = [{ from: n.id }];
            run = { node: n, count: 1 };
          }
          break;
        }
        case "return": {
          const n = add("return", s.label, s.startLine, s.endLine, s.calls);
          enter(n);
          link(n.id, END_ID);
          cur = [];
          break;
        }
        case "throw": {
          const n = add("throw", s.label, s.startLine, s.endLine, s.calls);
          enter(n);
          link(n.id, END_ID, "异常", "exception");
          cur = [];
          break;
        }
        case "break": {
          const n = add("process", "break", s.startLine, s.endLine);
          enter(n);
          if (ctx.breakExits) ctx.breakExits.push({ from: n.id });
          else link(n.id, END_ID);
          cur = [];
          break;
        }
        case "continue": {
          const n = add("process", "continue", s.startLine, s.endLine);
          enter(n);
          if (ctx.continueTarget) link(n.id, ctx.continueTarget, undefined, "back");
          cur = [];
          break;
        }
        case "if": {
          const d = add("decision", `${s.cond}?`, s.startLine, s.startLine, s.calls);
          enter(d);
          const th = seq(s.then, [{ from: d.id, label: "是" }], ctx);
          const el = seq(s.else, [{ from: d.id, label: "否" }], ctx);
          cur = [...th.exits, ...el.exits];
          break;
        }
        case "loop": {
          if (s.kind === "do") {
            const cond = add("loop", s.cond, s.endLine, s.endLine, s.calls);
            const lctx: LoopCtx = { breakExits: [], continueTarget: cond.id };
            const body = seq(s.body, cur, lctx);
            if (entry === null) entry = body.entry ?? cond.id;
            if (body.entry === null) connect(cur, cond.id);
            connect(body.exits, cond.id);
            link(cond.id, body.entry ?? cond.id, "是", "back");
            cur = [{ from: cond.id, label: "否" }, ...(lctx.breakExits ?? [])];
          } else {
            const head = add("loop", s.cond, s.startLine, s.startLine, s.calls);
            enter(head);
            const lctx: LoopCtx = { breakExits: [], continueTarget: head.id };
            const body = seq(s.body, [{ from: head.id, label: s.kind === "for" ? "遍历" : "是" }], lctx);
            for (const e of body.exits) link(e.from, head.id, e.label, "back");
            const normalExit: Exit = { from: head.id, label: s.kind === "for" ? "结束" : "否" };
            const tail = s.orElse.length ? seq(s.orElse, [normalExit], ctx).exits : [normalExit];
            cur = [...tail, ...(lctx.breakExits ?? [])];
          }
          break;
        }
        case "try": {
          const tn = add("try", "try", s.startLine, s.startLine);
          enter(tn);
          const body = seq(s.body, [{ from: tn.id }], ctx);
          let exits: Exit[] = body.exits;
          if (s.orElse.length) exits = seq(s.orElse, exits, ctx).exits;
          for (const h of s.handlers) {
            const hn = add("handler", h.label, h.startLine, h.startLine);
            link(tn.id, hn.id, "异常", "exception");
            const hb = seq(h.body, [{ from: hn.id }], ctx);
            exits = [...exits, ...hb.exits];
          }
          if (s.finally.length) {
            const fin = seq(s.finally, exits, ctx);
            exits = fin.exits;
          }
          cur = exits;
          break;
        }
        case "switch": {
          const sw = add("switch", `switch ${s.disc}`, s.startLine, s.startLine, s.calls);
          enter(sw);
          const sctx: LoopCtx = { breakExits: [], continueTarget: ctx.continueTarget };
          let prev: Exit[] = [];
          const all: Exit[] = [];
          for (const c of s.cases) {
            const cn = add("case", c.label, c.startLine, c.startLine);
            link(sw.id, cn.id);
            if (s.fallthrough) connect(prev, cn.id);
            const cb = seq(c.body, [{ from: cn.id }], sctx);
            prev = cb.exits;
            if (!s.fallthrough) all.push(...cb.exits);
          }
          if (s.fallthrough) all.push(...prev);
          const hasDefault = s.cases.some((c) => c.isDefault);
          cur = [...all, ...(sctx.breakExits ?? []), ...(hasDefault ? [] : [{ from: sw.id, label: "无匹配" }])];
          break;
        }
      }
    }
    return { entry, exits: cur };
  };

  const main = seq(ir, [{ from: start.id }], { breakExits: null, continueTarget: null });
  const end: FlowNode = { id: END_ID, kind: "end", label: "结束", startLine: endLine, endLine, calls: [] };
  nodes.push(end);
  connect(main.exits, END_ID);
  // 移除指向不存在节点的边（防御）并去重
  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const cleaned = edges.filter((e) => {
    if (!ids.has(e.source) || !ids.has(e.target)) return false;
    const key = `${e.source}>${e.target}>${e.label ?? ""}>${e.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { nodes, edges: cleaned, truncated };
}
