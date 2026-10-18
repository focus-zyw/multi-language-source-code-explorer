/** Client-safe browsing limits, shared by the tree and explanation panel. */
export const STRUCTURE_PAGE_SIZE = 50;

export function structurePageSize<T>(children: readonly T[], requested = STRUCTURE_PAGE_SIZE): number {
  return Math.min(children.length, requested);
}

/** Reveal an out-of-page selection without rendering every preceding sibling. */
export function structurePageItems<T extends { id: number }>(children: readonly T[], requested = STRUCTURE_PAGE_SIZE, selectedId: number | null = null): T[] {
  const items = children.slice(0, structurePageSize(children, requested));
  const selected = selectedId === null ? undefined : children.find((child) => child.id === selectedId);
  if (selected && !items.some((child) => child.id === selected.id)) items.push(selected);
  return items;
}

export function isJsonDependencyLock(path: string): boolean {
  return /^(?:package-lock|npm-shrinkwrap)\.json$/i.test(path.replaceAll("\\", "/").split("/").at(-1) ?? "");
}
