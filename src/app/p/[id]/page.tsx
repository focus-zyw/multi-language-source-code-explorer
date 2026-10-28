import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getAiPublicStatus } from "@/lib/ai";
import { getProject, getTree, parseId } from "@/lib/queries";
import { Workspace } from "@/components/Workspace";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (!id) notFound();
  const project = await getProject(id);
  if (!project) notFound();
  const tree = await getTree(id);
  return (
    <Suspense fallback={<div className="p-8 text-slate-400">加载中…</div>}>
      <Workspace key={`${project.id}:${project.createdAt}:${project.scanRevision}`} project={project} tree={tree} ai={getAiPublicStatus()} />
    </Suspense>
  );
}
