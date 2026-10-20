import "server-only";
import { createHash } from "node:crypto";
import { getAgentConfig } from "./agent.ts";
import type { ChatConfig } from "./ai-chat.ts";
import type { AiPublicStatus, ExplanationBackend } from "./ai-types";
export { AiError } from "./ai-error.ts";
export { completeChat } from "./ai-chat.ts";
export type { ChatOptions } from "./ai-chat.ts";

/**
 * AI 讲解：模型 API Key 只从服务端环境变量读取，从不返回给前端。
 *
 * 环境变量：
 *   AI_API_KEY      （或 OPENAI_API_KEY / ANTHROPIC_API_KEY）
 *   AI_BASE_URL     OpenAI 兼容接口地址，默认 https://api.openai.com/v1
 *   AI_MODEL        模型名，默认 gpt-4o-mini（Anthropic 默认 claude-3-5-haiku-latest）
 *   AI_PROVIDER     openai | anthropic（可省略，仅设置 ANTHROPIC_API_KEY 时自动为 anthropic）
 *   AI_TIMEOUT_MS / AI_IDLE_TIMEOUT_MS / AI_RETRY_ATTEMPTS  传输层超时与重试，见 ai-chat.ts
 */

export type AiConfig = ChatConfig;

export function getAiConfig(): AiConfig | null {
  const env = process.env;
  const anthropicOnly = !env.AI_API_KEY && !env.OPENAI_API_KEY && !!env.ANTHROPIC_API_KEY;
  const apiKey = env.AI_API_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY;
  if (!apiKey || !apiKey.trim()) return null;
  const provider: AiConfig["provider"] = env.AI_PROVIDER === "anthropic" || (anthropicOnly && env.AI_PROVIDER !== "openai") ? "anthropic" : "openai";
  const baseUrl = (env.AI_BASE_URL || (provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1")).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) return null;
  const model = env.AI_MODEL || (provider === "anthropic" ? "claude-3-5-haiku-latest" : "gpt-4o-mini");
  return { provider, apiKey: apiKey.trim(), baseUrl, model };
}

/** 前端可见的状态：只暴露是否可用与模型名，绝不包含密钥/地址 */
export function getAiPublicStatus(): AiPublicStatus {
  const c = getAiConfig();
  const agent = getAgentConfig();
  const defaultBackend = process.env.AI_EXPLAIN_BACKEND === "agent" ? "agent"
    : process.env.AI_EXPLAIN_BACKEND === "api" ? "api" : c ? "api" : "agent";
  const agentModel = agent ? `Codex · ${agent.model ?? "默认模型"}` : null;
  return { configured: !!c || !!agent, model: defaultBackend === "api" ? c?.model ?? null : agentModel,
    defaultBackend, backends: { api: { available: !!c, model: c?.model ?? null }, agent: { available: !!agent, model: agentModel } } };
}

/** Cache identity changes with execution backend and model, never includes a secret. */
export function explanationConfigKey(backend: ExplanationBackend): string {
  const config = backend === "api" ? getAiConfig() : getAgentConfig();
  const identity = config && ("provider" in config
    ? [config.provider, config.baseUrl, config.model]
    : [config.command, config.model]);
  return createHash("sha256").update(JSON.stringify([backend, identity])).digest("hex");
}

export { EXPLAIN_SYSTEM_PROMPT, buildExplainPrompt } from "./explain-prompt.ts";
