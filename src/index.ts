/**
 * pi-wecom-envoy 入口
 *
 * 单 Node 进程：
 *   1) 加载 config.yaml
 *   2) ModelRuntime.create() — 复用用户 ~/.pi/agent/* 配置
 *   3) SessionRegistry 持有 N 个 AgentSession
 *   4) Wecom 长连接收到消息 → 找/建 session → 订阅事件 → 流式回写
 */

import { writeFile } from "node:fs/promises";
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
  log.info("config ok", { configPath: cfgPath });

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
    const key = msg.chatType === "single"
      ? { chatType: "single" as const, chatId: msg.chatId }
      : { chatType: "group" as const, chatId: msg.chatId, userId: msg.fromUserId };

    let entry;
    try {
      entry = await registry.acquire(key);
    } catch (err) {
      log.error("acquire session failed", err);
      await wecom.reply({ msgId: msg.msgId, chatId: msg.chatId, chatType: msg.chatType }, "内部错误：会话初始化失败。").catch(() => { /* ignore */ });
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

  log.info("prompt", { key: entry.keyStr, textLen: userText.length, imageCount: images.length });

  let acc = "";
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
          const slice = acc.length > cfg.runtime.maxReplyChars
            ? acc.slice(0, cfg.runtime.maxReplyChars) + "\n…(已截断)"
            : acc;
          lastSent = now;
          lastSentText = acc;
          stream.push(slice, { finish: false }).catch((e) => log.warn("streaming push failed", e));
        }
      }
    }
    if (event.type === "agent_settled" || event.type === "agent_end") {
      settled = true;
      log.info("pi settled", { key: entry.keyStr, accLen: acc.length });
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

  // 最终一次：保证把 acc 完整发出去
  const final = acc.length > cfg.runtime.maxReplyChars
    ? acc.slice(0, cfg.runtime.maxReplyChars) + "\n…(已截断)"
    : acc;
  if (stream) {
    if (final && final !== lastSentText) {
      try {
        await stream.push(final, { finish: true });
      } catch (e) {
        log.warn("final stream push failed", e);
      }
    } else {
      // 没产生新内容也要 finish
      try { await stream.push("", { finish: true }); } catch (e) { log.warn("final stream empty push failed", e); }
    }
    try { await stream.close(); } catch { /* ignore */ }
  } else if (final) {
    // 没有流式通道，降级到主动 send
    try {
      await wecom.send(target.chatId, target.chatType, final);
    } catch (e) {
      log.warn("fallback send failed", e);
    }
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", e);
  process.exit(1);
});