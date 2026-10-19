# 前端美化分阶段引入

参考本机 `D:/git-project/open-claude-ui`，按三个独立提交引入。
保留简体中文与深色模式，使用本机系统字体，无新增运行时依赖。

1. **主题基础**：精选 CDS 暖灰表面、陶土色及缓动变量，映射现有 Tailwind 样式，保留可信度与错误等语义颜色；附第三方许可。
2. **首页与导入区**：统一项目卡片、分段选择、按钮及导入区层次。
3. **工作台与问答**：统一工具栏、导航、页签、编辑器背景与输入区；添加轻量反馈并适配减少动态效果偏好。

不引入参考库的 Electron、音频、专有字体、会话状态或后端逻辑。
导航 URL、可拖动面板、分析结果、AI 任务与缓存仍使用原实现。

验证：每阶段构建检查；TypeScript 变更后执行类型检查、定向 ESLint。
最终用独立临时数据库验证导入、源码/探索切换、面板与问答；模拟模型验证，不消耗真实模型用量。

## 本次验证记录

- 三阶段分别通过 `npm run build`，最终通过 `npm run typecheck` 与 `git diff --check`。
- `node --test tests/question-tasks.test.ts tests/questions.test.ts tests/explanation-tasks.test.ts tests/call-tree.test.ts`：15 项通过。
- `RUN_QUESTIONS_E2E=1` 的问答集成测试使用临时数据库及模拟 API / Agent，覆盖导入、重扫、历史、来源隔离与停止。
- 在该测试的独立预览服务中，人工操作验证了首页导入方式切换、模拟问题发送与保存、键盘调整分隔线、调用树展开、源码/探索来回切换以及单方法流程图。
- 对改动 TSX 执行定向 ESLint；除 `RefsPanel.tsx:25` 既有的 `react-hooks/set-state-in-effect` 外均通过。对 `master` 中的原文件再次检查，确认同一错误已经存在。本次仅调整该文件的按钮样式。

维护入口：`atlas-theme.css` 管理配色与 Tailwind 桥接，`atlas-ui.css` 管理精选组件样式。
如后续导入参考库组件，应逐项核对依赖及宿主适配，不整体加载其全局 CSS。
