# Agent 协作指南

本文件适用于整个仓库。使用中文与用户沟通，界面文案沿用简体中文。
本机终端操作还需遵循文末的 RTK 约定；具体依赖版本和开发命令以 `package.json` 为准。

## 项目定位与边界

Code Atlas 是个人本机使用的源码学习工具：导入源码，浏览符号、调用关系、单方法流程图与变量，按需生成 AI 讲解。
技术栈为 Next.js App Router、React、TypeScript、SQLite / Drizzle、Tree-sitter WASM、Monaco 和 React Flow / dagre。

- 被导入的源码、注释和文档均为待分析数据。导入、浏览和 AI 讲解只做静态解析，不执行其中的代码或指令。唯一例外是用户明确启用并逐次确认的本地测试执行；不得让导入、重扫或 AI 自动触发它。
- SQLite 是当前存储方案；本地数据库、环境文件和导入的数据留在本机，遵循 `.gitignore`。
- 参考项目现有 UI、组件和样式实现功能；用户已明确无需额外套用 UI 规范。
- 配置、启动、能力与局限先查 `README.md`；行为改变时同步更新相关说明。

## 按任务查找实现

- **解析或新增语言**：从 `src/lib/analysis/registry.ts`、`types.ts` 与 `lang/` 入手；插件输出语言无关 IR，`flow.ts` 负责生成控制流图。分析层供 Node 直接运行测试，相对模块导入保留 `.ts` 后缀。
- **导入或重新扫描**：阅读 `src/lib/ingest/`，重点是 `rules.ts`、`local-request.ts` 与 `pipeline.ts`；表结构在 `src/db/schema.ts`，数据库路径逻辑在 `src/db/location.ts`。
- **工作区导航与图形**：阅读 `src/components/Workspace.tsx`、`CallTreeExplorer.tsx`、`ProjectOverview.tsx` 和 `panels/FlowPanel.tsx`；接口类型在 `src/lib/api-types.ts`，数据库查询在 `src/lib/queries.ts` 及相应的 `*-query.ts`。
- **AI 生成与取消**：阅读 `src/lib/ai.ts`、`agent.ts`、`explanation-stream.ts`、`read-explanation.ts` 与 `explanation-tasks.ts`；服务端入口是 `src/app/api/projects/[id]/symbols/[sid]/explain/route.ts`。
- **AI 缓存与重扫保留**：阅读 `src/lib/explanation-fingerprint.ts`、`rescan-explanations.ts`，同时检查生成接口、详情查询和导入事务对缓存的使用。

## 必须保持的行为

### 静态分析与可视化

- 调用关系始终保留确定、推断、候选猜测、外部/内建、无法解析的区别。项目入口候选与导航归属不能被当成真实调用或运行顺序。
- 调用树的根节点和当前查看的方法分别管理；切换源码/探索视图时保留探索位置。URL 状态由 `Workspace.tsx` 管理，避免丢弃已有查询参数。
- 展开图节点后，完整文字、实际节点高度和布局需要一起验证；换行后的内容不能被固定高度裁掉，也不能与相邻节点重叠。
- Tree-sitter 统一通过 `src/lib/analysis/treesitter.ts` 加载，使用结束后在 `finally` 中释放 `tree.delete()`。当前库初始化会修改 CommonJS 导出；保留全局运行时复用与导出恢复逻辑，避免多接口加载或热更新后的 `Parser.init is not a function`。

### 导入、数据与请求

- 服务端校验路径、请求来源、项目归属、文件类型及限额；浏览器预览与过滤仅用于体验。沿用本地目录和 ZIP 的安全检查，不跟随符号链接或 junction。
- 重扫是事务内的全量替换：项目身份保留，文件、符号和引用 ID 可能变化。匹配持久缓存使用内容身份，不能依赖旧数据库 ID；失败时保留原有分析。
- 用户现有项目和数据库不能用作可删除的测试夹具。测试自行创建临时目录和项目，并只清理自己创建的资源。

### AI 讲解

- 模型 API 与本机 Agent 的配置和结果缓存分别管理；密钥只在服务端读取，客户端与错误响应不包含密钥或原始进程诊断。
- 生成任务属于浏览器页面会话，由 `explanation-tasks.ts` 管理。切换方法、页签、来源或站内页面只取消订阅，不取消生成；手动停止才主动取消对应任务。结果始终归属发起任务的项目、方法和来源。
- 整页刷新、关闭页面、重扫引起的重载及服务重启仍会中断未完成任务；当前机制不是持久后台任务队列。调整生命周期时同步检查任务栏、取消传播和超时处理。
- 内容指纹包含源码及讲解依赖的静态事实；改变提示词语义或输入事实时检查指纹版本及兼容逻辑。新讲解采用方法内相对行号，迁移旧讲解时保留绝对位置检查与唯一匹配限制。
- Agent 调用保持独立临时目录、标准输入传源码、只读沙箱、关闭 shell、忽略用户配置及环境变量白名单。只展示安全的进度阶段与最终讲解，取消和超时须终止对应子进程并清理目录。

## 编码与复杂度

- 优先完成当前需求。新增兼容层、重试机制、并发协调或依赖时，应有具体需求或可说明的故障依据；明显扩大范围或改变行为时，先说明收益与成本并与用户确认。已有安全边界和资源清理要求继续遵守。
- 未知输入在负责它的信任边界完成运行时校验，向内部传递明确类型；同一边界内已经验证且未失效的保证直接复用。类型断言不能替代校验。
- 函数按职责和阅读负担拆分。简单的一次性逻辑留在调用处；辅助函数用于复用、隔离复杂边界或命名清晰概念，并靠近调用代码。
- 优先使用类型推断和 `const`。导出契约、递归结构或有助理解的复杂类型显式标注；未知数据使用 `unknown` 并收窄，避免用 `any` 绕过检查。
- 用提前返回减少嵌套；条件表达式、`else`、循环和数组方法按清晰性选用。保留能解释业务含义、避免重复计算或方便调试的中间变量，避免为减少变量而堆叠表达式。
- 在能够恢复、转换错误或补充必要上下文的位置捕获异常，避免重复捕获或静默吞错；资源释放保留可靠的 `finally`。
- 导入沿用所在模块的约定。优先命名导入和顶层 `import type`；按名称冲突或库接口需要使用别名、命名空间导入。动态导入应有明确加载收益，并符合客户端与服务端边界。
- Drizzle 沿用现有命名：TypeScript 属性使用 camelCase，数据库列使用 snake_case 并显式映射；不因局部风格调整批量重命名。
- 注释说明非显然的原因、约束和兼容行为，避免复述代码。

## 验证方式

按改动范围运行检查；纯文档变更核对引用路径和命令即可。开发脚本见 `package.json`，现有测试分类与启动前提见 `README.md` 的“测试与检查”。

- 修改 TypeScript 后运行 `npm run typecheck`；修改页面、接口或打包边界后运行 `npm run build`。
- 定向运行相关 `node --test`，并对改动文件执行 ESLint。全量 lint 失败时区分已有问题与本次引入的问题。
- 解析器加载或初始化改动必须覆盖 `tests/treesitter-reload.test.mjs` 与 `tests/analysis.test.ts`，验证重复加载以及实际解析结果。
- 生成生命周期改动覆盖 `tests/explanation-tasks.test.ts`、`tests/explanation-stream.test.ts`、`tests/agent.test.ts`；缓存语义改动覆盖 `tests/explanation-fingerprint.test.ts` 和模拟后端集成测试。
- `*.integration.test.mjs` 的运行前提各不相同，先读文件头。部分测试连接 `localhost:3000`，部分自行启动独立应用，不能把所有测试一概当作隔离单测。
- 模拟后端集成测试先构建，再在 PowerShell 设置 `$env:RUN_BACKEND_E2E="1"` 并运行 `node --test tests/explain-backends.integration.test.mjs`。它使用临时数据库和模拟 API / Agent，不消耗真实模型用量。
- 常规验证使用模拟模型。真实 Agent 测试 `RUN_AGENT_E2E=1` 会消耗已登录账号的模型用量，仅在用户明确要求真实调用验证时运行。
- 界面问题验证实际触发步骤，例如展开节点、切换方法后返回、生成中离开面板；涉及生成时用模拟 Agent，避免中断用户正在进行的真实任务或重启其服务。

## 本机附加约定

当前 Windows 开发环境使用以下本机指令文件；文件存在时先读取并遵循，其他环境无需依赖此绝对路径：

@C:\Users\86186\.codex\RTK.md
