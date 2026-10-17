import { getAiPublicStatus } from "@/lib/ai";
import { listProjects } from "@/lib/queries";
import { ImportPanel } from "@/components/ImportPanel";
import { ProjectList } from "@/components/ProjectList";
import { RESOLUTION_LABELS, type ResolutionT } from "@/lib/shared";
import { ConfidenceBadge } from "@/components/Badges";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const projects = await listProjects();
  const ai = getAiPublicStatus();
  const levels: ResolutionT[] = ["exact", "inferred", "heuristic", "external", "unresolved"];

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-indigo-300">Code Atlas</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-white">源码学习台</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
            导入本地源码 → 浏览函数/方法 → 阅读源码与讲解 → 查看关联测试 → 点击引用跳转 → 流程图与关键变量。
            所有关系都标注可信度，猜测不会被伪装成事实。
          </p>
        </div>
        <div
          className={`rounded-full px-3 py-1.5 text-xs ring-1 ring-inset ${ai.configured ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/40" : "bg-slate-800 text-slate-400 ring-slate-700"}`}
          title="模型密钥只在服务端环境变量中读取，不会发送到浏览器"
        >
          {ai.configured ? `AI 讲解已启用 · ${ai.model ?? "可选来源"}` : "AI 讲解未配置 · 使用静态摘要"}
        </div>
      </header>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <ImportPanel />
        <section>
          <h2 className="mb-3 text-base font-semibold text-slate-100">我的项目</h2>
          <ProjectList projects={projects} />
        </section>
      </div>

      <section className="mt-10 rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
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
