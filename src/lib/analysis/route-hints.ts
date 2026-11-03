export interface RouteHint { methods: string[]; paths: string[]; partial: boolean; evidence: string[]; note: string }
const VERBS: Record<string, string> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", head: "HEAD", options: "OPTIONS", websocket: "WEBSOCKET" };

// Read only literal arguments. Expressions, constants and template strings stay unknown.
function literals(expression: string): string[] {
  const input = expression.trim();
  if (input.startsWith("[") || input.startsWith("{")) {
    const end = input[0] === "[" ? "]" : "}";
    const values: string[] = [];
    let rest = input.slice(1).trim();
    while (rest && !rest.startsWith(end)) {
      const match = /^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/.exec(rest);
      if (!match) return [];
      values.push(match[1] ?? match[2]); if (values.length > 32) return []; rest = rest.slice(match[0].length).trim();
      if (rest.startsWith(",")) rest = rest.slice(1).trim(); else if (!rest.startsWith(end)) return [];
    }
    return rest.startsWith(end) && /^(?:\s*[,)]|\s*$)/.test(rest.slice(1)) ? values : [];
  }
  const match = /^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/.exec(input);
  if (!match || !/^(?:\s*[,)]|\s*$)/.test(input.slice(match[0].length))) return [];
  return [match[1] ?? match[2]];
}

function pathsOf(text: string): string[] {
  const args = text.slice(text.indexOf("(") + 1, text.lastIndexOf(")") >= 0 ? text.lastIndexOf(")") : undefined);
  const named = /(?:^|,)\s*(?:path|value|template)\s*[:=]\s*([\s\S]*)/.exec(args);
  return literals(named?.[1] ?? args);
}

export function routeHint(decorators: string[], path: string, parentDecorators: string[] = []): RouteHint | null {
  const java = path.endsWith(".java"), python = path.endsWith(".py"), csharp = path.endsWith(".cs"), typescript = /\.[cm]?[jt]sx?$/.test(path);
  const routes = decorators.filter((value) => java ? /^@(?:[\w.]*\.)?(?:RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\b/.test(value)
    : python ? /^@(?:\w+\.)+(?:route|get|post|put|patch|delete|head|options|websocket)\s*\(/.test(value)
    : csharp ? /^\[(?:[\w.]+\.)?(?:Http(?:Get|Post|Put|Patch|Delete|Head|Options)|Route)\b/.test(value)
    : typescript && /^@(?:[\w.]*\.)?(?:Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(/.test(value));
  if (!routes.length) return null;
  const methods = new Set<string>(), paths = new Set<string>(); let partial = false;
  for (const route of routes) {
    const name = /^[@[]([\w.]+)/.exec(route)?.[1].split(".").at(-1) ?? "";
    const verb = name.replace(/Mapping$/, "").replace(/^Http/, "").toLowerCase();
    if (VERBS[verb]) methods.add(VERBS[verb]);
    else {
      const javaMethods = [...route.matchAll(/RequestMethod\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((match) => match[1]);
      const pyMethods = /\bmethods\s*=\s*([\s\S]*)/.exec(route);
      const known = javaMethods.length ? javaMethods : pyMethods ? literals(pyMethods[1]).map((value) => value.toUpperCase()).filter((value) => Object.values(VERBS).includes(value)) : [];
      for (const method of known.length ? known : ["未限定"]) methods.add(method);
    }
    const literalsFound = pathsOf(route);
    if (literalsFound.length) for (const value of literalsFound) paths.add(value);
    else if (/\(\s*\)$/.test(route)) paths.add("");
    else partial = true;
    if (!route.endsWith(")")) partial = true;
  }
  const prefixDecorator = parentDecorators.find((value) => java ? /^@(?:[\w.]*\.)?RequestMapping\b/.test(value) : csharp ? /^\[(?:[\w.]+\.)?Route\b/.test(value) : typescript && /^@(?:[\w.]*\.)?Controller\s*\(/.test(value));
  let result = [...paths];
  if (prefixDecorator) {
    const prefixes = pathsOf(prefixDecorator);
    if (prefixes.length) result = prefixes.flatMap((prefix) => result.map((value) => `/${[prefix, value].map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")}`));
    else partial = true;
    // Class-level method constraints and additional prefixes need framework semantics.
    if (/RequestMethod\.|headers\s*=|params\s*=|consumes\s*=|produces\s*=/.test(prefixDecorator)) partial = true;
  }
  return { methods: [...methods], paths: [...new Set(result)].slice(0, 32), partial: partial || result.length > 32 || routes.length > 8, evidence: routes.slice(0, 8).map((value) => value.slice(0, 500)),
    note: python ? "仅提取装饰器字面量，未合并路由挂载前缀或验证运行时注册" : "按框架注解约定合并类与方法字面量，未验证导入来源、组合注解、继承或运行时注册" };
}
