import { TraceWorkbench } from "@/components/TraceWorkbench";

export const dynamic = "force-dynamic";

export const metadata = { title: "调用树追踪 · Code Atlas" };

export default function TracePage() {
  return <TraceWorkbench />;
}
