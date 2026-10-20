"use client";

import { useMemo } from "react";
import type { SymbolDetail, TestLinkView } from "@/lib/api-types";
import type { ResolutionT } from "@/lib/shared";
import { KindIcon, TestConfidenceBadge } from "../Badges";
import { TestRunPanel } from "./TestRunPanel";

interface Props {
  projectId: number;
  detail: SymbolDetail;
  onNavigate: (id: number, note?: { text: string; level: ResolutionT }) => void;
}

const METHOD_LABEL: Record<TestLinkView["method"], string> = {
  "direct-call": "测试代码直接调用",
  "indirect-call": "经由其他方法间接调用",
  "name-match": "命名/文件名启发式",
};

const GROUPS: { key: TestLinkView["confidence"]; title: string; desc: string }[] = [
  { key: "exact", title: "确定：直接调用", desc: "测试里的调用被静态确定地解析到目标" },
  { key: "inferred", title: "推断：直接调用", desc: "依赖类型标注/构造推断或路径别名，较可信" },
  { key: "indirect", title: "间接调用", desc: "测试 → 中间方法 → 目标，只沿确定/推断的边传递一层" },
  { key: "heuristic", title: "猜测：命名或同名候选", desc: "未验证，可能是误判" },
];

export function TestsPanel({ projectId, detail, onNavigate }: Props) {
  const isTest = detail.symbol.kind === "test";
  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, items: detail.tests.filter((t) => t.confidence === g.key) })).filter((g) => g.items.length), [detail.tests]);
  const toLevel = (c: TestLinkView["confidence"]): ResolutionT => (c === "indirect" ? "inferred" : c);

  return (
    <div className="p-4">
      <TestRunPanel key={`${projectId}:${detail.symbol.id}`} projectId={projectId} detail={detail} />
      <p className="mb-3 text-xs leading-5 text-slate-400">
        {isTest
          ? "这个测试用例静态可见的“被测对象”如下（沿调用链解析得到，并非运行时覆盖率）。"
          : "与该" + (detail.symbol.kind === "class" ? "类（含其方法）" : "方法") + "关联的测试。关系来自静态调用解析与命名启发式，不代表实际运行覆盖。"}
      </p>
      {groups.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-800 p-8 text-center text-sm leading-6 text-slate-500">
          {isTest ? "该测试里没有解析到指向项目内代码的调用。" : "未匹配到关联测试。"}
          <br />
          <span className="text-xs">这不代表没有测试：可能通过动态方式、夹具或未支持的语法间接调用。</span>
        </div>
      )}
      <div className="space-y-5">
        {groups.map((g) => (
          <section key={g.key}>
            <div className="mb-1.5 flex items-baseline gap-2">
              <TestConfidenceBadge level={g.key} />
              <span className="text-[11px] text-slate-500">{g.desc}</span>
            </div>
            <ul className="space-y-1.5">
              {g.items.map((t, idx) => (
                <li key={`${t.otherSymbolId}-${t.targetSymbolId}-${idx}`}>
                  <button
                    onClick={() => onNavigate(t.otherSymbolId, { text: `${isTest ? "被测对象" : "关联测试"}：${t.reason}`, level: toLevel(t.confidence) })}
                    className="block w-full rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-left hover:border-indigo-500/50"
                  >
                    <div className="flex items-center gap-2">
                      <KindIcon kind={t.otherKind} />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-slate-100">{t.otherName}</span>
                      <TestConfidenceBadge level={t.confidence} score={t.score} />
                    </div>
                    <div className="mt-0.5 truncate pl-6 text-[11px] text-slate-500">
                      {t.filePath}:{t.line}
                    </div>
                    {!isTest && detail.symbol.kind === "class" && t.targetSymbolId !== detail.symbol.id && (
                      <div className="mt-0.5 pl-6 text-[11px] text-indigo-300">覆盖成员：{t.targetName}</div>
                    )}
                    <div className="mt-1 pl-6 text-[11px] leading-4 text-slate-500">
                      <span className="text-slate-400">{METHOD_LABEL[t.method]}</span>
                      {t.via ? `（经 ${t.via.name}）` : ""} — {t.reason}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
