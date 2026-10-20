# 模型输出与重试契约

本分支参考本地 `D:\git-project\codex` 的实现思想，核对版本为 `e18a20d6eb6f5ede32a69fb56e3fe276d5e9d914`。以下链接固定到该提交，升级 Codex CLI 时可据此检查行为变化。Code Atlas 独立实现了适合当前 OpenAI Chat Completions / Anthropic Messages 接口的传输层，没有引入 Codex 的完整运行时。

## 对应源码

- [Codex SSE 完成与不完整响应处理](https://github.com/openai/codex/blob/e18a20d6eb6f5ede32a69fb56e3fe276d5e9d914/codex-rs/codex-api/src/sse/responses.rs)：显式完成状态、提前断流与空闲超时；本项目对应 `src/lib/ai-chat.ts`。
- [Codex 服务端重试截止时间](https://github.com/openai/codex/blob/e18a20d6eb6f5ede32a69fb56e3fe276d5e9d914/codex-rs/http-client/src/retry_after.rs)及[重试预算与状态通知](https://github.com/openai/codex/blob/e18a20d6eb6f5ede32a69fb56e3fe276d5e9d914/codex-rs/core/src/responses_retry.rs)：保存服务端建议的最早重试时间，传递时不重新开始等待；本项目对应 `ai-chat.ts`、`explanation-stream.ts` 和 `explanation-tasks.ts`。
- [Codex exec 最终消息输出](https://github.com/openai/codex/blob/e18a20d6eb6f5ede32a69fb56e3fe276d5e9d914/codex-rs/exec/src/event_processor_with_jsonl_output.rs)及[完成时回填规则](https://github.com/openai/codex/blob/e18a20d6eb6f5ede32a69fb56e3fe276d5e9d914/codex-rs/exec/src/lib.rs)：本项目的 `src/lib/agent.ts` 优先读取 `--output-last-message` 文件，JSONL 消息作为兼容回退，同时要求正常退出和 `turn.completed`。这不构成对所有历史 CLI 版本的兼容保证。

## Code Atlas 的行为

流式响应必须收到对应提供商的完成标记。OpenAI 显式返回的 `finish_reason` 只接受 `stop`；Anthropic 的 `stop_reason` 只接受 `end_turn` 或 `stop_sequence`。空值或缺失字段保留兼容能力；显式的长度截断、过滤、工具请求及未知结束原因报安全错误，不自动重试、不保存部分讲解。直接返回 JSON 的兼容端点也检查结束原因。此规则不校验讲解内容本身的准确性，也不追溯清理历史缓存。

`AI_TIMEOUT_MS` 限制等待响应头的时间，以及非流式响应的总时长；流式响应开始后改用 `AI_IDLE_TIMEOUT_MS`。重试仅发生在尚未收到正文时，且受 `AI_RETRY_ATTEMPTS` 的总尝试次数限制。

有效的 `Retry-After` 秒数或 HTTP 日期从收到响应头时换算为单调时钟截止时间，读取错误正文所花的时间计入等待。服务端要求的等待时间不会被本地退避上限压短；缺失或无效时才使用本地指数退避。长等待分段使用定时器，手动停止可立即中断。客户端只收到下一次尝试序号、总尝试次数、安全原因类别和预计重试时间，不收到密钥或上游诊断。

任务继续属于浏览器页面会话：切换方法、来源或离开面板只取消订阅；手动停止会取消等待及对应请求。成功、失败或停止时清理重试状态。刷新、关闭页面或服务重启仍可能中断任务。

## 验证

`tests/ai.test.ts` 使用本地桩服务覆盖两种提供商、SSE / JSON 的结束原因、超出 8 秒的等待、HTTP 日期、等待取消及空闲超时。`tests/explanation-stream.test.ts` 与 `tests/explanation-tasks.test.ts` 覆盖状态传递和任务生命周期。

构建后按 README 的说明运行 `tests/explain-backends.integration.test.mjs`，用临时数据库验证失败不会覆盖旧缓存、重试状态可传到浏览器协议、成功结果正常保存；测试不消耗真实模型用量。
