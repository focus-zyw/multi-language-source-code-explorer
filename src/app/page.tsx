import { getAiPublicStatus } from "@/lib/ai";
import { listProjects } from "@/lib/queries";
import { ImportPanel } from "@/components/ImportPanel";
import { ProjectList } from "@/components/ProjectList";
import { RESOLUTION_LABELS, type ResolutionT } from "@/lib/shared";
import { ConfidenceBadge } from "@/components/Badges";
import { ThemeToggle } from "@/components/ThemeToggle";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const projects = await listProjects();
  const ai = getAiPublicStatus();
  const levels: ResolutionT[] = ["exact", "inferred", "heuristic", "external", "unresolved"];

  return (
    <main className="atlas-home mx-auto min-h-screen px-4 py-8 sm:px-8 sm:py-12">
      <header className="atlas-home-header flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="atlas-wordmark"><span className="atlas-mark" aria-hidden="true">&lt;/&gt;</span>CODE ATLAS <span className="tracking-normal text-slate-500">/ 本地源码工作台</span></p>
          <h1 className="atlas-heading mt-6 text-4xl text-slate-100 sm:text-5xl">让源码，变得清晰。</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
            从一个方法开始，读源码、追踪调用、探索流程，再向 AI 追问。
            本机静态分析，每一处关系都标注可信度。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3"><ThemeToggle /><div
          className={`rounded-full px-3 py-1.5 text-xs ring-1 ring-inset ${ai.configured ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/40" : "bg-slate-800 text-slate-400 ring-slate-700"}`}
          title="模型密钥只在服务端环境变量中读取，不会发送到浏览器"
        >
          {ai.configured ? `AI 讲解已启用 · ${ai.model ?? "可选来源"}` : "AI 讲解未配置 · 使用静态摘要"}
        </div></div>
      </header>

      <div className="mt-8 grid items-start gap-8 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <ImportPanel />
        <section>
          <div className="mb-4 flex items-center justify-between"><h2 className="text-base font-semibold text-slate-100">我的项目</h2><span className="text-xs tabular-nums text-slate-500">{projects.length} 个项目</span></div>
          <ProjectList projects={projects} />
        </section>
      </div>

      <section className="atlas-trust mt-10">
        <h2 className="text-sm font-semibold text-slate-200">引用可信度说明</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {levels.map((l) => (
            <div key={l} className="rounded-lg bg-slate-950/50 p-3">
              <ConfidenceBadge level={l} />
              <p className="mt-2 text-xs leading-5 text-slate-400">{RESOLUTION_LABELS[l].hint}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
