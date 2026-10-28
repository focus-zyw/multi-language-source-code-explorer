# GitHub 对标调研：star > 1000 的相近项目，以及本项目可借鉴的内容

> 调研时间：2026-10-20。star / 最近提交来自 GitHub REST API 实测（未登录配额），
> 排序与数字均为当日快照。Aider、Repomix、SCIP、elkjs 的机制读了源码或官方文档；
> 其余项目按各自文档化能力判断，未逐行读实现。

---

## 一、项目画像（先说清楚"我们是什么"）

Code Atlas 不是通用代码搜索，也不是 IDE 插件，而是一个**本机、只读、面向"读懂一个陌生项目"的学习台**。
`src/` 下 121 个文件、约 13.2k 行 TS/TSX，核心资产集中在三处：

| 层 | 关键文件 | 现状 |
| --- | --- | --- |
| 解析层 | `analysis/lang/*.ts`（javascript 1201 行、python 771 行、resolve 656 行） | 8 种语言的手写 AST 遍历 + 5 级可信度解析 |
| 数据层 | `db/schema.ts`：`symbols / refs / ref_targets / test_links / symbol_explanations / symbol_questions` | 自增整数 ID，重扫即全量替换 |
| 交互层 | `Workspace.tsx`、`CallTreeExplorer.tsx`、`panels/FlowPanel.tsx`（dagre 布局） | 源码 / 调用树 / 流程图 / 变量 / 测试 / 问答 |

已经做得比多数开源同类更细的地方，恰恰是**可信度模型**（exact / inferred / heuristic / external / unresolved）
和**内容指纹缓存**（`explanation-fingerprint.ts`）。这两点很多对标项目都没有。

但对照下来，有四个结构性短板：

1. **AI 讲解只看一个方法**。`explain-prompt.ts` 只发当前方法源码 + facts + 调用清单；
   问答要用户手动勾最多 3 个补充方法。模型看不到项目全貌，讲解容易"局部正确、全局跑偏"。
2. **符号身份不稳定**。`symbols.id` 是自增整数，重扫后全变；书签、讲解缓存、问答记录都要靠
   "路径 + 限定名 + 源码指纹"重新猜回同一个符号，猜不到就停用。这是三处痛点的同一个根因。
3. **学习导航只有圈复杂度**。`SymbolMetrics.complexity` 是 CCN，对"读起来累不累"的区分度很差。
4. **只能按元数据搜符号**。`symbol-search-sql.ts` 用 `instr(lower(name), q) > 0` 匹配名称和路径，
   没有源码全文、没有代码形状搜索。

---

## 二、对标清单

### A. 同类竞品：交互式源码探索 / 交叉引用

| 仓库 | star | 语言 | 最近提交 | 与本项目的关系 |
| --- | ---: | --- | --- | --- |
| [CoatiSoftware/Sourcetrail](https://github.com/CoatiSoftware/Sourcetrail) | 16,466 | C++ | 2021-12（归档） | **最接近的形态**：索引器 + SQLite + 图形化探索，call/inheritance/include 图、Active Trail、书签 |
| [oracle/opengrok](https://github.com/oracle/opengrok) | 5,010 | Java | 2026-10-20 | 源码搜索 + xref 交叉引用引擎，符号定义/引用跳转的经典实现 |
| [doxygen/doxygen](https://github.com/doxygen/doxygen) | 6,595 | C++ | 2026-10-17 | caller/call/include 图与"文档即图"的成熟范式 |
| [sourcegraph/sourcegraph-public-snapshot](https://github.com/sourcegraph/sourcegraph-public-snapshot) | 10,286 | Go | 2024-09（归档） | 代码搜索 + 精确跳转的工业级参考（Zoekt + SCIP） |
| [joernio/joern](https://github.com/joernio/joern) | 3,583 | Scala | 2026-10-20 | Code Property Graph：把 AST/CFG/PDG 合成一张图查询 |
| [facebookincubator/Glean](https://github.com/facebookincubator/Glean) | 1,430 | Haskell | 2026-10-20 | "源码事实"建模 + Angle 查询语言 |
| [scottrogowski/code2flow](https://github.com/scottrogowski/code2flow) | 4,612 | Python | 2025-07 | 动态语言调用图，明确接受"不完美"的实用主义 |
| [sourcebot-dev/sourcebot](https://github.com/sourcebot-dev/sourcebot) | 4,001 | TypeScript | 2026-10-16 | 自托管、面向人和 agent 的代码理解入口 |

### B. 依赖图 / 死代码 / 度量

| 仓库 | star | 语言 | 最近提交 | 可借鉴 |
| --- | ---: | --- | --- | --- |
| [webpro-nl/knip](https://github.com/webpro-nl/knip) | 12,483 | TypeScript | 2026-10-20 | 未使用文件/导出/依赖的判定策略 |
| [SonarSource/sonarqube](https://github.com/SonarSource/sonarqube) | 11,091 | Java | 2026-10-19 | **认知复杂度（Cognitive Complexity）**规范 |
| [pahen/madge](https://github.com/pahen/madge) | 10,176 | JavaScript | 2026-01 | 模块依赖图 + 循环检测 |
| [boyter/scc](https://github.com/boyter/scc) | 8,833 | Go | 2026-10-20 | SLOC / 复杂度 / COCOMO 的聚合口径 |
| [sverweij/dependency-cruiser](https://github.com/sverweij/dependency-cruiser) | 7,309 | JavaScript | 2026-10-19 | 依赖规则 + 违规报告（不只画图） |
| [kucherenko/jscpd](https://github.com/kucherenko/jscpd) | 6,423 | Rust | 2026-10-19 | 重复代码检测，可作"相似方法"学习入口 |
| [pmd/pmd](https://github.com/pmd/pmd) | 5,512 | Java | 2026-10-19 | 多语言规则集与 CCN 阈值 |
| [terryyin/lizard](https://github.com/terryyin/lizard) | 2,561 | JavaScript | 2026-10-20 | 跨语言 CCN/NLOC/参数数 + warning 阈值 |
| [rubik/radon](https://github.com/rubik/radon) | 2,037 | Python | 2024-10 | 可维护性指数 MI、Halstead 指标 |
| [XAMPPRocky/tokei](https://github.com/XAMPPRocky/tokei) | 15,007 | Rust | 2026-09 | 快速统计（本项目已有项目级统计） |

### C. 解析与索引基础设施

| 仓库 | star | 语言 | 最近提交 | 可借鉴 |
| --- | ---: | --- | --- | --- |
| [tree-sitter/tree-sitter](https://github.com/tree-sitter/tree-sitter) | 27,237 | Rust | 2026-10-20 | **增量解析**（本项目仍是全量重扫）；query 语法 |
| [semgrep/semgrep](https://github.com/semgrep/semgrep) | 17,146 | OCaml | 2026-10-20 | 类源码的模式语言（pattern 即代码） |
| [ast-grep/ast-grep](https://github.com/ast-grep/ast-grep) | 16,289 | Rust | 2026-10-20 | **YAML 规则 + tree-sitter query**，声明式结构搜索 |
| [microsoft/pyright](https://github.com/microsoft/pyright) | 15,689 | Python | 2026-10-19 | Python 类型推断的工程上限参考 |
| [universal-ctags/ctags](https://github.com/universal-ctags/ctags) | 7,299 | C | 2026-10-11 | 跨语言 tag 抽象（"什么算一个符号"） |
| [davidhalter/jedi](https://github.com/davidhalter/jedi) | 6,183 | Python | 2026-10-18 | Python 名字解析 / goto / infer 的实用实现 |
| [github/codeql](https://github.com/github/codeql) | 10,218 | CodeQL | 2026-10-20 | 关系型语义模型（与"安全扫描"目的不同） |

### D. AI 代码理解与上下文构建（与本项目短板最直接相关）

| 仓库 | star | 语言 | 最近提交 | 可借鉴 |
| --- | ---: | --- | --- | --- |
| [Aider-AI/aider](https://github.com/Aider-AI/aider) | 49,659 | Python | 2026-05 | **Repo Map**：tree-sitter tags + PageRank + token 预算二分 |
| [oraios/serena](https://github.com/oraios/serena) | 30,446 | Python | 2026-10-20 | 用 LSP 做符号级检索/编辑，而非自研解析 |
| [yamadashy/repomix](https://github.com/yamadashy/repomix) | 28,930 | TypeScript | 2026-10-18 | **`--compress`**：tree-sitter 压成"签名 + 注释 + `⋮----`"，省约 70% token |
| [ahmedkhaleel2004/gitdiagram](https://github.com/ahmedkhaleel2004/gitdiagram) | 18,336 | TypeScript | 2026-10-20 | 仓库 → 架构图的一键生成路径 |
| [AsyncFuncAI/deepwiki-open](https://github.com/AsyncFuncAI/deepwiki-open) | 18,230 | Python | 2026-09 | AI 生成的分层 Wiki 结构（概览 → 模块 → 细节） |
| [zilliztech/claude-context](https://github.com/zilliztech/claude-context) | 12,630 | TypeScript | 2026-07 | 语义检索式上下文（向量检索，本项目未必需要） |
| [vitali87/code-graph-rag](https://github.com/vitali87/code-graph-rag) | 5,268 | Python | 2026-10-20 | tree-sitter + 图数据库的多语言代码知识图谱 |

### E. 可视化 / 布局

| 仓库 | star | 语言 | 最近提交 | 可借鉴 |
| --- | ---: | --- | --- | --- |
| [mermaid-js/mermaid](https://github.com/mermaid-js/mermaid) | 90,770 | TypeScript | 2026-10-20 | 流程图文本化导出（非主渲染） |
| [d2lang/d2](https://github.com/d2lang/d2) | 25,686 | Go | 2026-10-11 | 声明式图 + 自动布局的设计取舍 |
| [kieler/elkjs](https://github.com/kieler/elkjs) | 2,834 | JavaScript | 2026-10-19 | **layered 布局**：嵌套图、端口、正交路由、Web Worker |

### 附：低于 1000 star 但技术高度相关（不进入推荐，仅作参考）

- [sourcegraph/scip](https://github.com/sourcegraph/scip) 834：符号字符串格式（下文的稳定 ID 来源）
- [github/stack-graphs](https://github.com/github/stack-graphs) 875（归档）：增量名字解析
- [MaibornWolff/codecharta](https://github.com/MaibornWolff/codecharta) 554：代码地图可视化
- [Technologicat/pyan](https://github.com/Technologicat/pyan) 461 / [vitsalis/PyCG](https://github.com/vitsalis/PyCG) 364：Python 调用图算法

---

## 三、高价值借鉴点（按 ROI 排序）

### 1. 用 Repo Map 给 AI 补"项目全貌" ★★★★★

**问题**：`explain-prompt.ts` 里模型只看到当前方法。它能讲清"这段代码做了什么"，
但讲不清"这个方法在系统里的位置"——而这恰恰是学习者最需要的。

**借鉴**：Aider 的 `repomap.py`。核心机制（已读源码确认）：

1. 用 tree-sitter tag query（`*-tags.scm`）抽 `name.definition.*` / `name.reference.*` 两类 tag；
2. 以"共享标识符"连边构建文件级多重有向图，边权 `mul × sqrt(refs)`；
   `mentioned_idents` ×10、chat 内文件 ×50、以下划线开头 ×0.1、被 5 个以上文件定义 ×0.1；
3. 跑 **personalized PageRank**，personalization 来自"当前会话文件 / 提到的文件名 / 提到的标识符"；
4. 把 top-N tag 渲染成缩进骨架，**二分搜索** N 使 token 数落在预算内（容差 `ok_err = 0.15`）。

**本项目适配**：不需要 tag query，也不需要新解析——`symbols` + `refs` + `ref_targets` 已经够。

```
输入：projectId, 当前 symbolId, 用户勾选的补充方法, token 预算
1. 图：节点 = symbol；边 = ref_targets（exact 1.0 / inferred 0.6 / heuristic 0.2）
2. PageRank(personalization = 当前方法 ×50, 勾选方法 ×10, 同文件 ×5, 其余 1)
3. top-N 渲染骨架：qualifiedName + signature + docstring 首行，按文件分组
4. 二分 N 使骨架 ≤ 预算（复用现有 token 估算，或按字符数 ×0.6 粗估）
```

**落点**：新增 `src/lib/repo-map.ts`（纯函数，可直接 `node --test`），
在 `explain-prompt.ts` / `question-context.ts` 拼装时插入 `### 项目结构（按相关度排序，非完整源码）` 段。
**成本**：中低。**风险**：PageRank 在 5000 符号规模下需要控制迭代次数；
必须在 UI 上标明"这是按静态引用排序的骨架，不代表执行顺序"——与本项目一贯的可信度口径一致。

---

### 2. 符号骨架压缩（给上下文瘦身） ★★★★★

**问题**：Repo Map 给出"哪些方法重要"，但真正要看它们时，整段源码会迅速吃满预算。

**借鉴**：Repomix `--compress`。用 tree-sitter 把方法体替换为 `⋮----`，
只留 import、签名、docstring、interface/class 声明。官方口径：省约 70% token。

**本项目适配**：`ExtractedSymbol` 已记录 `defStartIndex / defEndIndex`（带函数体的节点范围），
配合 `startIndex / endIndex`（含装饰器的展示范围），可以直接从源码里切出"签名段"和"体段"，
不需要重新解析。对非当前方法一律用骨架，对当前方法保留全文。

**落点**：`src/lib/skeleton.ts`；`question-context.ts` 的补充方法拼装处。
**成本**：低。**风险**：低（纯展示层，不影响指纹）。

---

### 3. 稳定符号 ID，一次性解决三处跨重扫痛点 ★★★★★

**问题**：`symbols.id` 是自增整数，重扫全量替换后 ID 全变。
于是书签要靠 `anchorKey`、讲解缓存要靠 `fingerprint`、问答记录要靠 `identity`
各自"猜回"同一个符号，猜不到就停用/失效。三套机制、一个根因。

**借鉴**：SCIP 的符号字符串格式（已核对 `scip.proto` 注释块）：

```
<symbol>     ::= <scheme> ' ' <package> ' ' (<descriptor>)+ | 'local ' <local-id>
<package>    ::= <manager> ' ' <package-name> ' ' <version>
<descriptor> ::= <namespace> '/' | <type> '#' | <term> '.' | <method> '(' <disambiguator>? ').'
```

官方示例：`com/example/MyClass#myMethod(+1).`。要点是**符号身份由"包 + 限定名 + 消歧符"构成，
与提交、行号、数据库 ID 无关**；行号和内容属于"occurrence"，不属于"symbol"。

**本项目适配**：

```
code-atlas python . 0 src/app/service.py/OrderService#pay(+1).
         ↑scheme  ↑mgr ↑pkg ↑ver ↑namespace        ↑type   ↑method(消歧)
```

- `namespace` 用项目内路径（`/` 分隔），`#` 表示类型，`(...)` 表示方法，
  `(+1)` 用参数个数做重载消歧（Java/Go 重载场景必需）；
- 重扫时按 `stableId` 匹配即可认定"同一符号"，即使 `symbols.id` 变了；
- **内容指纹保持独立**：`stableId` = 身份，`fingerprint` = 内容版本。
  现有 `explanation-fingerprint.ts` 只需把 `qualifiedName` 换成 `stableId`，
  版本号从 1/2/3 升到 4，并保留旧指纹的只读回退。

**落点**：`db/schema.ts` 加 `symbols.stable_id` + 唯一索引；
`ingest/pipeline.ts` 生成；`learning-store.ts` / `questions-server.ts` / `rescan-explanations.ts`
改用 stableId 匹配（可删掉大量启发式重定位代码）。
**成本**：中（需要迁移：老库加列并回填一次）。**风险**：中——重命名/移动方法仍然会变 ID，
但这与现状一致，不倒退；好处是"仅插入行""仅改方法体"不再导致身份丢失。

---

### 4. 认知复杂度替代"唯 CCN"的学习排行 ★★★★☆

**问题**：CCN 把 `switch` 的每个 `case`、平铺的 10 个 `if` 和嵌套 10 层的 `if` 记成差不多的分数，
但学习者感受到的难度天差地别。

**借鉴**：SonarQube 的 Cognitive Complexity。规则大意：

- **+1**：`if`、`else if`、`else`、三元、`switch`、`for`、`while`、`do-while`、`catch`、
  `break/continue` 到标签、每段连续的 `&&`/`||` 序列、递归环中的每个方法；
- **+nesting**：条件/循环/`switch`/`catch` **内部**再出现上述结构时，额外加当前嵌套层数；
- **不加分**：`try`、`finally`、普通 `break/continue`、方法调用本身。

直觉上就是"嵌套惩罚 + 线性流断裂惩罚"，比 CCN 更贴近"读起来累不累"。

**本项目适配**：`SymbolMetrics` 加 `cognitive`；各语言插件的 `metrics` 计算处增量维护
`nestingDepth`（多数插件已经有 `flowIR` 的递归结构，可以复用同一遍遍历）。
`summary.ts`、`project-insights.ts`、`symbol-search` 的排序选项各加一个 `cognitive`。
**成本**：低（每语言 ~20 行）。**风险**：低——但要在 UI 说明"两种复杂度口径不同，不可相加"。

---

### 5. 孤立符号清单：学习导航的另一极 ★★★★☆

**问题**：现有排行只有"被调用最多"，回答不了"这个项目里哪些代码没人用"。
对学习者来说，**零调用方的导出**往往是最安全的上手点（或是死代码，值得警惕）。

**借鉴**：knip 的判定策略——未使用导出 = 有导出声明、无项目内引用、非入口、非测试。

**本项目适配**：一条 SQL 就能出。

```sql
-- 零调用方、非测试、非入口的导出方法
select s.id, s.qualified_name, f.path
from symbols s join files f on f.id = s.file_id
where s.project_id = ? and s.is_test = 0
  and s.kind in ('function','method')
  and not exists (select 1 from ref_targets t join refs r on r.id = t.ref_id
                  where t.target_symbol_id = s.id and t.confidence in ('exact','inferred'))
```

需要注意排除"入口方法"（`project-entries.ts` 已有识别结果）和"框架回调"（Vue 模板处理器等，
`ExtractedCall.origin` 已标记）——否则会把 Spring Controller 全列成死代码。
**落点**：`project-insights.ts` 新增一个区块。**成本**：很低。**风险**：低，但必须标注
"静态不可见动态调用（反射、装饰器注册、框架约定），此列表不等于可删除"。

---

### 6. 声明式提取：让"新增一种语言"变便宜 ★★★★☆

**问题**：`javascript.ts` 1201 行、`python.ts` 771 行，都是手写 AST 遍历。
README 说"实现 `LanguagePlugin` 即可新增语言"，但实际门槛很高。

**借鉴**：ast-grep 的 YAML 规则（`pattern` / `kind` / `inside` / `has` / `not` / `all` / `any`）
与 Aider 的 `*-tags.scm`。两者都是"用 tree-sitter query 声明要找什么"，而不是用宿主语言写遍历。

**本项目适配**：**不要重写现有插件**。新语言（Ruby、Rust、C#、PHP…）先走
"`symbols.scm` + `calls.scm` + 少量 TS 后处理"的混合路线：

```
lang/ruby/
  symbols.scm   ; (method name: (identifier) @name.definition.method)
  calls.scm     ; (call method: (identifier) @name.reference.call)
  index.ts      ; 把 query capture 映射到 ExtractedSymbol / ExtractedCall
```

query 表达力不足的部分（如 `receiverKind` 需要看 `self`/`this`/`super` 语义）
再用 20~30 行 TS 补。旧插件保持不动，避免回归。
**成本**：中。**风险**：中——query 无法表达"需要跨节点上下文"的判断，
必须承认新语言的可信度上限可能低于现有 8 种语言，并在 `analysisNotes` 里写明。

---

### 7. 结构化代码搜索（按代码形状搜，而非按名字搜） ★★★☆☆

**问题**：现在只能按名称/路径/注解/复杂度筛符号。真实需求经常是
"哪里调了 `redis.get`""哪些 `if` 直接 `return null`"——这是**形状**，不是元数据。

**借鉴**：ast-grep 的 rule 语义（`pattern` + `inside` / `has` / `not` + `all`/`any`）。

**本项目适配**：分两步走，避免一次性上规则引擎：

- **第一步（低成本）**：SQLite FTS5 建 `files.content` 全文索引（`trigram` tokenizer，
  SQLite 3.34+ 提供），支持源码全文/子串/正则近似检索。
  这同时补上"不支持正则"的缺口——对代码阅读工具这是基本盘。
  注意：需先确认 `@libsql/client` 的构建启用了 FTS5，未启用则退回 `instr()` + 分页。
- **第二步（可选）**：对方法体文本做 AST 复核，把"文本命中"升级为"结构命中"，
  输出仍走现有 `refs`/`symbols` 的可信度口径。

**落点**：`db/schema.ts` 新增 FTS 虚表 + `ingest/pipeline.ts` 写入；`symbol-search-sql.ts` 加一个搜索模式。
**成本**：中。**风险**：中——FTS 索引会让导入变慢、库变大，需要按项目开关。

---

### 8. 布局引擎：dagre → elkjs layered ★★★☆☆

**问题**：`FlowPanel.tsx:77-88` 用 dagre。dagre 对**嵌套结构**（`try/catch/finally`、`switch/case`）
和**回边**（`break`/`continue`/`return` 穿越）的表达力有限，容易出现长边交叉和节点重叠。

**借鉴**：elkjs 的 `layered`（Sugiyama 系），支持递归嵌套图、显式端口、正交/样条边路由，
且可跑在 Web Worker 里不阻塞 UI。

**本项目适配**：`FlowGraph` 的 `try`/`switch` 节点天然是"容器"，正好映射到 ELK 的嵌套图；
`break`/`continue` 的 `back` 边可以走端口约束。**但**必须同时解决
README 已经强调过的"展开节点后实际高度"问题——ELK 需要准确尺寸才能布局，
现有实现里节点高度是动态测量的，需要在测量完成后再触发布局。
**成本**：中。**风险**：中——这是纯 UI 层改动，但会影响所有语言的流程图观感，需要逐语言目测。

---

### 9. LSP 作为"可选增强解析后端" ★★☆☆☆

**问题**：`resolve.ts` 656 行自研解析，README 诚实列了一堆局限（不读 `tsconfig.json`、
不做返回值类型推断、不做虚方法分派）。

**借鉴**：serena（30k star）的做法——不自己造解析器，直接用 LSP 的
`textDocument/definition`、`references`、`documentSymbol`。

**为什么不推荐现在做**：与本项目"零编译依赖、WASM 解析、纯静态只读"的核心取舍**正面冲突**。
LSP 要求目标项目已装依赖、能起语言服务器，且对 Python/Java 需要额外进程管理。
**如果要做**，只作为"增强后端"：检测到 `node_modules/typescript` 或 `pyright` 时才启用，
结果单独标注 `exact(lsp)` 并**不覆盖**现有静态结果，让用户自己对比。
**成本**：高。**风险**：高——会打破现有"导入即分析、无需配置"的体验。

---

### 10. AI 讲解的引用锚点与结构图 ★★☆☆☆

**问题**：讲解是纯 Markdown，读者要自己回头找代码位置。

**借鉴**：DeepWiki 的分层 Wiki 结构、gitdiagram 的架构图生成。

**本项目适配**：问答面板**已经有**"只有指向实际提供片段且行号有效的引用才可点击"的机制
（`question-types.ts` 的引用校验）。把同一套机制搬到讲解：要求模型在"执行步骤"里
用 `[L12-L18]` 标注，服务端校验行号落在方法范围内才渲染成可点击锚点。
**成本**：低。**风险**：低（模型可能不按格式输出，降级为纯文本即可，与现有行为一致）。

---

## 四、不建议照搬的

| 对象 | 原因 |
| --- | --- |
| Sourcetrail 的 C++ 索引器 / clang 依赖 | 与本项目"WASM、零编译、跨平台"的核心取舍冲突 |
| Sourcegraph 的 Zoekt + 多仓库索引 | 个人本机单项目场景，运维复杂度远超收益 |
| Semgrep / CodeQL 的规则引擎 | 目的是安全扫描，不是"读懂代码"；规则语言的学习成本对本项目用户无价值 |
| Glean 的 facts + Angle | 建模能力强但学习曲线陡，现有 SQLite + Drizzle 已够用 |
| mermaid / D2 作为主渲染 | 需要点击节点跳转源码、展开节点，React Flow 更合适；只建议作"导出"用 |
| code-graph-rag 的图数据库 | SQLite 递归 CTE 已能覆盖调用树与循环检测，引入 Neo4j/Memgraph 过重 |
| 向量检索（claude-context） | 本项目已有精确的符号图，语义检索的边际收益低，且增加 embedding 依赖 |

---

## 五、建议的落地顺序

**第一批（低风险、复用现有数据、可直接感知收益）**

1. 认知复杂度 → `SymbolMetrics.cognitive`，排行/搜索/摘要三处接入
2. 孤立符号清单 → `project-insights.ts` 一个区块
3. 符号骨架压缩 → `skeleton.ts`，先只用于问答的补充方法
4. Repo Map → `repo-map.ts`，接进 `explain-prompt.ts` 与 `question-context.ts`

前两项是"加一个指标"，后两项是"改上下文拼装"，都不动解析层和数据库结构，
可以独立提交、独立验证（`node --test` 即可覆盖纯函数部分）。

**第二批（需要迁移，一次性解决存量痛点）**

5. 稳定符号 ID → 加列 + 回填 + 三处匹配逻辑切换

这一步做完，`learning-store.ts`、`questions-server.ts`、`rescan-explanations.ts`
里大量"启发式重定位"的代码可以删掉，是本轮**唯一能净减代码量**的改动。

**第三批（能力扩展，需要单独评估）**

6. FTS5 源码全文搜索（先验证 libsql 是否启用 FTS5）
7. 新语言走 `.scm` 声明式提取（不重写旧插件）
8. elkjs 布局替换（配合节点尺寸测量）
9. 讲解行号锚点

---

## 六、一句话结论

本项目在**可信度模型**和**静态事实的诚实边界**上，已经比多数 star 上万的对标项目做得更严谨；
真正的差距不在解析，而在两处：**AI 看不到项目全貌**（Aider 的 Repo Map 是现成答案），
以及**符号身份随重扫漂移**（SCIP 的符号格式是现成答案）。
这两件事都不需要新依赖，只需要把已有数据重新组织一遍。
