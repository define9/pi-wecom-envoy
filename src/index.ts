/**
 * pi-wecom-envoy 入口
 *
 * 单 Node 进程：
 *   1) 加载 config.yaml
 *   2) ModelRuntime.create() — 复用用户 ~/.pi/agent/* 配置
 *   3) SessionRegistry 持有 N 个 AgentSession
 *   4) Wecom 长连接收到消息 → 找/建 session → 订阅事件 → 流式回写
 */

import { writeFile, access } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ImageContent } from "@earendil-works/pi-ai";

import { loadConfig } from "./config.js";
import { Logger } from "./log.js";
import { SessionRegistry } from "./session/manager.js";
import {
  createWecomClient,
  type WecomClient,
  type WecomIncomingMessage,
} from "./wecom/client.js";

async function resolveModel(rt: ModelRuntime, provider: string, modelId: string): Promise<Model<any> | undefined> {
  if (!provider || !modelId) return undefined;
  const all = await rt.getAvailable();
  return all.find((m) => m.provider === provider && m.id === modelId);
}

async function main() {
  const cfg = await loadConfig();
  const cfgPath = cfg._loadedFrom ?? "(resolved)";

  const log = new Logger(cfg.runtime.logLevel);
  log.info("config ok", {
    configPath: cfgPath,
    processCwd: process.cwd(),
    workspaceRoot: cfg.pi.workspaceRoot,
    workspaceRootResolved: pathResolve(cfg.pi.workspaceRoot),
    workspaceRootExists: await access(pathResolve(cfg.pi.workspaceRoot)).then(() => true, () => false),
    perChatWorkspace: cfg.pi.perChatWorkspace,
  });

  // 写 pid 文件
  await writeFile(cfg.runtime.pidFile, String(process.pid), "utf8").catch(() => { /* ignore */ });

  // 1. ModelRuntime：复用 ~/.pi/agent/auth.json + models.json
  const modelRuntime = await ModelRuntime.create(
    cfg.pi.agentDir ? { authPath: pathResolve(cfg.pi.agentDir, "auth.json"), modelsPath: pathResolve(cfg.pi.agentDir, "models.json") } : {},
  );
  log.info("model runtime ready", { providers: modelRuntime.getProviders().map((p) => p.id) });

  const model = await resolveModel(modelRuntime, cfg.pi.provider, cfg.pi.model) as Model<any> | undefined;
  if (model) log.info("model selected", { provider: model.provider, id: model.id });
  else log.warn("no model specified; pi will use default from settings or first available");

  // 2. Session registry
  const registry = new SessionRegistry(cfg.pi, log);
  await registry.init(modelRuntime, model);

  // 3. Wecom 客户端
  const wecom: WecomClient = await createWecomClient(cfg.wecom, log);
  wecom.onError((e) => log.error("wecom error", e));

  wecom.onMessage(async (msg: WecomIncomingMessage) => {
    log.info("msg in", {
      msgId: msg.msgId,
      chatType: msg.chatType,
      chatId: msg.chatId,
      fromUserId: msg.fromUserId,
      textLen: msg.text?.length ?? 0,
      textPreview: (msg.text ?? "").slice(0, 200),
      imageCount: msg.images.length,
      fileCount: msg.files.length,
      hasQuote: !!msg.quote,
    });
    const key = msg.chatType === "single"
      ? { chatType: "single" as const, chatId: msg.chatId }
      : { chatType: "group" as const, chatId: msg.chatId, userId: msg.fromUserId };

    const target = { msgId: msg.msgId, chatId: msg.chatId, chatType: msg.chatType };

    // "开新会话"指令：发送 /new 会 dispose 当前 session，下次消息起新开一个 jsonl 文件
    const trimmed = msg.text?.trim() ?? "";
    if (trimmed === "/new") {
      const existing = registry.get(key);
      if (existing?.promptInFlight) {
        try { await existing.promptInFlight; } catch { /* ignore */ }
      }
      await registry.dispose(key);
      log.info("session reset", { key, command: trimmed });
      await wecom.reply(target, "已开新会话。旧会话已保留在服务端，下次消息起重新计数。").catch(() => { /* ignore */ });
      return;
    }

    let entry;
    try {
      entry = await registry.acquire(key);
    } catch (err) {
      log.error("acquire session failed", err);
      await wecom.reply(target, "内部错误：会话初始化失败。").catch(() => { /* ignore */ });
      return;
    }

    // 串行化：同一 session 同时只允许一个 prompt
    const prev = entry.promptInFlight ?? Promise.resolve();
    const next = prev.then(() => runPrompt(entry!, msg, cfg, log, wecom)).catch((e) => log.error("prompt error", e));
    entry.promptInFlight = next;
    await next;
  });

  await wecom.start();
  log.info("envoy started");

  const shutdown = async (sig: string) => {
    log.info("shutting down", { signal: sig });
    try { await wecom.stop(); } catch { /* ignore */ }
    try { await registry.disposeAll(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function runPrompt(
  entry: Awaited<ReturnType<SessionRegistry["acquire"]>>,
  msg: WecomIncomingMessage,
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  log: Logger,
  wecom: WecomClient,
): Promise<void> {
  const target = { msgId: msg.msgId, chatId: msg.chatId, chatType: msg.chatType };
  const userText = msg.text?.trim() ?? "";

  // 下载图片 — 超时/失败就降级到无图
  const images: ImageContent[] = [];
  for (let i = 0; i < msg.images.length; i++) {
    try {
      const img = await wecom.downloadImage(msg.msgId, i);
      images.push({ type: "image", data: img.base64, mimeType: img.mimeType });
    } catch (err) {
      log.warn("downloadImage failed", { index: i, err: String(err) });
    }
  }

  if (!userText && images.length === 0) {
    log.debug("empty message (no text, no images), skip", { key: entry.keyStr });
    return;
  }

  log.info("prompt", {
    key: entry.keyStr,
    textLen: userText.length,
    textPreview: userText.slice(0, 200),
    imageCount: images.length,
    thinkingMode: cfg.runtime.thinkingMode,
  });

  // 当前 turn 累积：
  //   acc            = 最近一次 assistant 的 text_delta 拼接
  //   thinkingBlocks = 最近一次 assistant 的所有 thinking 块（按 content 顺序）
  // 单次 prompt 可能含多轮（tool 调用后再来一次 assistant）；前缀只用最近一轮的。
  let acc = "";
  let thinkingBlocks: string[] = [];
  let lastSent = 0;
  let lastSentText = "";
  let settled = false;

  // 开启流式回复通道；中间帧走 SDK 的非阻塞版本，结束帧 finish=true
  let stream: ReturnType<WecomClient["startStream"]> | null = null;
  try {
    stream = wecom.startStream(target);
  } catch (err) {
    log.warn("startStream failed, fallback to single-shot reply", err);
    stream = null;
  }

  const unsub = entry.session.subscribe((event) => {
    log.debug("event", { key: entry.keyStr, type: event.type });
    if (event.type === "message_start") {
      // 每来一次新 assistant 消息就重置：保证 acc/thinkingBlocks 只反映"最近一轮"
      // 工具调用后再次 assistant 也走这里，不需要再靠 partial 探测
      const role = (event as any).message?.role;
      if (role === "assistant") {
        acc = "";
        thinkingBlocks = [];
        lastSent = 0;
        lastSentText = "";
      }
    }
    if (event.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub.type === "text_delta") {
        acc += sub.delta;
        const now = Date.now();
        if (
          cfg.runtime.streamingReply &&
          stream &&
          acc !== lastSentText &&
          now - lastSent >= cfg.runtime.streamingMinIntervalMs
        ) {
          // folded 模式：流式正文先按"裸 acc"推送；前缀在最终收尾时再补
          const slice = acc.length > cfg.runtime.maxReplyChars
            ? acc.slice(0, cfg.runtime.maxReplyChars) + "\n…(已截断)"
            : acc;
          lastSent = now;
          lastSentText = acc;
          stream.push(slice, { finish: false }).catch((e) => log.warn("streaming push failed", e));
          log.debug("stream push", { accLen: acc.length });
        }
      } else if (sub.type === "thinking_start") {
        // 占位：等 thinking_end / 后续 delta 累加
        const idx = sub.contentIndex;
        while (thinkingBlocks.length <= idx) thinkingBlocks.push("");
      } else if (sub.type === "thinking_delta") {
        // 累加到对应 contentIndex 的 thinking 块（start/delta/end 严格成对）
        const idx = sub.contentIndex;
        while (thinkingBlocks.length <= idx) thinkingBlocks.push("");
        thinkingBlocks[idx] += sub.delta;
      }
    }
    if (event.type === "message_end") {
      // 用 SDK 给的最终 message 校正：某些 provider 在 delta 之外还可能合并
      // (例如 openai-responses 的 redacted thinking 不会发 delta 但 message_end 全量补齐)
      const m: any = (event as any).message;
      if (m?.role === "assistant" && Array.isArray(m.content)) {
        const ts: string[] = [];
        for (const b of m.content) if (b && b.type === "thinking" && typeof b.thinking === "string") ts.push(b.thinking);
        thinkingBlocks = ts;
      }
    }
    if (event.type === "agent_settled" || event.type === "agent_end") {
      settled = true;
      log.info("pi settled", { key: entry.keyStr, accLen: acc.length, thinkingBlocks: thinkingBlocks.length });
    }
    if (event.type === "tool_execution_start") {
      log.info("tool start", { tool: event.toolName, argsPreview: JSON.stringify(event.args).slice(0, 200) });
    }
    if (event.type === "tool_execution_end") {
      log.info("tool done", { tool: event.toolName, isError: event.isError });
    }
  });

  try {
    await entry.session.prompt(userText, images.length > 0 ? { images } : undefined);
  } catch (err) {
    log.error("prompt threw", err);
    const stateErr = entry.session.agent.state.errorMessage;
    if (stateErr) log.error("agent state errorMessage", stateErr);
    await wecom.reply(target, "内部错误：模型调用失败。").catch(() => { /* ignore */ });
    return;
  } finally {
    unsub();
  }

  if (!settled) settled = true;

  // 思考摘要：尾部优先截断
  function summarizeThinking(blocks: string[], max: number): string {
    const joined = blocks.filter((s) => s && s.trim().length > 0).join("\n\n---\n\n");
    if (!joined) return "";
    if (joined.length <= max) return joined;
    const head = Math.floor(max / 3);
    const tail = max - head - 8;
    return `…${joined.slice(joined.length - head - tail)}\n…(已截断)`;
  }

  const thinkingSummary = summarizeThinking(thinkingBlocks, cfg.runtime.thinkingMaxChars);
  const mode = cfg.runtime.thinkingMode;

  // 统一打"msg out"日志：长度、模式、是否被截断
  log.info("msg out", {
    key: entry.keyStr,
    mode,
    accLen: acc.length,
    thinkingBlocks: thinkingBlocks.length,
    thinkingSummaryLen: thinkingSummary.length,
    thinkingPreview: thinkingSummary.slice(0, 200),
    accPreview: acc.slice(0, 200),
    accTruncated: acc.length > cfg.runtime.maxReplyChars,
  });

  if (stream) {
    // 独立模式：先主动 send 思考摘要（独立消息，独立 streamId，不影响正文 stream）
    if (mode === "separate" && thinkingSummary) {
      try {
        await wecom.send(
          target.chatId,
          target.chatType,
          `> 💭 **思考过程**\n${thinkingSummary.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}`,
        );
        log.debug("thinking summary sent (separate)", { len: thinkingSummary.length });
      } catch (e) {
        log.warn("separate thinking send failed", e);
      }
    }

    // 正文：folded 模式前缀注入，separate 模式裸 acc
    const prefix = mode === "folded" && thinkingSummary
      ? `> 💭 **思考过程**\n${thinkingSummary.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}\n\n`
      : "";
    const bodyMax = cfg.runtime.maxReplyChars;
    let bodyCap = bodyMax - prefix.length;
    if (bodyCap < 200) bodyCap = 200;
    const finalBody = acc.length > bodyCap
      ? acc.slice(0, bodyCap) + "\n…(已截断)"
      : acc;
    const final = prefix + finalBody;

    if (final && final !== lastSentText) {
      try {
        await stream.push(final, { finish: true });
        log.debug("final stream push", { mode, len: final.length });
      } catch (e) {
        log.warn("final stream push failed", e);
      }
    } else {
      // 没产生新内容也要 finish
      try { await stream.push("", { finish: true }); } catch (e) { log.warn("final stream empty push failed", e); }
    }
    try { await stream.close(); } catch { /* ignore */ }
  } else if (acc) {
    // 没有流式通道，降级到主动 send：folded 在前缀，separate 把思考拼成另一条
    const prefix = mode === "folded" && thinkingSummary
      ? `> 💭 **思考过程**\n${thinkingSummary.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}\n\n`
      : "";
    if (mode === "separate" && thinkingSummary) {
      try {
        await wecom.send(
          target.chatId,
          target.chatType,
          `> 💭 **思考过程**\n${thinkingSummary.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}`,
        );
      } catch (e) {
        log.warn("separate thinking send failed", e);
      }
    }
    if (prefix || acc) {
      const final = prefix + acc;
      try {
        await wecom.send(target.chatId, target.chatType, final);
      } catch (e) {
        log.warn("fallback send failed", e);
      }
    }
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", e);
  process.exit(1);
});