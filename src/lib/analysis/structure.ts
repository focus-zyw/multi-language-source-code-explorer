import type { ExtractedSymbol, LanguagePlugin, SyntaxNode } from "./types.ts";
import { rangeOf } from "./util.ts";

/** Structural nodes share navigation/storage with symbols, never call edges. */
export function structureSymbol(node: SyntaxNode, localId: number, parentLocalId: number | null, name: string, qualifiedName: string, signature: string, description: string): ExtractedSymbol {
  return { localId, parentLocalId, classLocalId: null, kind: "element", name, qualifiedName, container: null,
    isAsync: false, isGenerator: false, isTest: false, isDefaultExport: false, signature, params: [], decorators: [], docstring: description,
    returnType: null, bases: [], ...rangeOf(node), defStartIndex: node.startIndex, defEndIndex: node.endIndex,
    metrics: { loc: node.endPosition.row - node.startPosition.row + 1, params: 0, branches: 0, loops: 0, handlers: 0, returns: 0, throws: 0, awaits: 0, booleanOps: 0, complexity: 0 } };
}

export const structureDefaults: Pick<LanguagePlugin, "isTestFile" | "flowIR" | "analyzeVariables" | "resolveImport" | "joinSubmodule" | "builtinFunctions" | "globalObjects" | "builtinMethods" | "constructorNames"> = {
  isTestFile: () => false, flowIR: () => [], analyzeVariables: () => [], resolveImport: () => ({ kind: "external" }), joinSubmodule: () => null,
  builtinFunctions: new Set(), globalObjects: new Set(), builtinMethods: new Set(), constructorNames: [],
};
