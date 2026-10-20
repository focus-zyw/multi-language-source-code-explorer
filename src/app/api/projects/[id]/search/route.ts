import { getSymbolSearch } from "@/lib/symbol-search-query";
import { readSymbolSearch, SearchInputError } from "@/lib/symbol-search";
import { parseId } from "@/lib/queries";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (!id) return Response.json({ error: "无效的项目 ID" }, { status: 400 });
  try {
    const input = readSymbolSearch(new URL(request.url).searchParams);
    const result = await getSymbolSearch(id, input);
    return result ? Response.json(result) : Response.json({ error: "项目不存在" }, { status: 404 });
  } catch (error) {
    if (error instanceof SearchInputError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
