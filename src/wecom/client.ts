/**
 * 企微智能机器人长连接客户端
 *
 * 适配 @wecom/aibot-node-sdk（v1.x）。
 * 流式回复走 SDK 的 replyStream / replyStreamNonBlocking。
 * 图片/文件下载走 SDK 的 downloadFile（自动 AES 解密）。
 */

import { randomUUID } from "node:crypto";

import AiBot, {
  type BaseMessage,
  type FileContent,
  type ImageContent,
  type MixedContent,
  type TextMessage,
  type WsFrame,
  type WsFrameHeaders,
} from "@wecom/aibot-node-sdk";

import type { WecomConfig } from "../config.js";
import type { Logger } from "../log.js";

/** 用户发来的企微图片（含原始加密信息） */
export interface WecomImageAttachment {
  msgtype: "image";
  url: string;
  aeskey?: string;
  /** 调用 download() 后填充：mime + base64 data */
  downloaded?: { mimeType: string; base64: string };
}

export interface WecomFileAttachment {
  msgtype: "file";
  url: string;
  aeskey?: string;
  downloaded?: { mimeType: string; base64: string };
}

export interface WecomMixedAttachment {
  msgtype: "mixed";
  items: Array<
    | { msgtype: "text"; text: string }
    | { msgtype: "image"; url: string; aeskey?: string }
  >;
  downloadedImages?: { mimeType: string; base64: string }[];
}

/** 规范化后的入站消息 */
export interface WecomIncomingMessage {
  msgId: string;
  chatId: string;
  chatType: "single" | "group";
  fromUserId?: string;
  /** 文本部分（图文混排里 text 项拼接而成；纯图片消息时为空字符串） */
  text: string;
  /** 附带图片（图消息/mixed 消息里的图片项） */
  images: WecomImageAttachment[];
  /** 附带文件 */
  files: WecomFileAttachment[];
  /** 引用内容（用户引用了某条消息） */
  quote?: {
    msgtype: "text" | "image" | "mixed" | "voice" | "file";
    text?: string;
    imageUrl?: string;
  };
}

export interface WecomReplyTarget {
  msgId: string;
  chatId: string;
  chatType: "single" | "group";
}

export interface WecomClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 被动回复 — 关联 msgId，依赖原始 frame 的 req_id（5 分钟时效内） */
  reply(target: WecomReplyTarget, text: string): Promise<void>;
  /** 主动发送（不受 reply 时效限制） */
  send(chatId: string, chatType: "single" | "group", text: string): Promise<void>;
  /** 开启一条流式回复（SDK 会按 req_id 串行发送） */
  startStream(target: WecomReplyTarget): WecomReplyStream;
  /** 下载并解密图片，返回 base64 + mime（同一消息会缓存） */
  downloadImage(msgId: string, imageIndex?: number): Promise<{ mimeType: string; base64: string }>;
  /** 下载并解密文件 */
  downloadFile_(msgId: string, fileIndex?: number): Promise<{ mimeType: string; base64: string }>;
  onMessage(handler: (msg: WecomIncomingMessage) => void): void;
  onError(handler: (err: unknown) => void): void;
}

export interface WecomReplyStream {
  readonly streamId: string;
  push(content: string, opts?: { finish?: boolean }): Promise<void>;
  close(): Promise<void>;
}

/** 保留原始 frame 用于 downloadFile（需要 req_id 吗？downloadFile 走 HTTP，不要） */
interface FrameEntry {
  msgId: string;
  chatId: string;
  chatType: "single" | "group";
  fromUserId?: string;
  text: string;
  images: WecomImageAttachment[];
  files: WecomFileAttachment[];
  quote?: WecomIncomingMessage["quote"];
  headers: WsFrameHeaders;
}

export async function createWecomClient(cfg: WecomConfig, log?: Logger): Promise<WecomClient> {
  const sdkLog = {
    debug: (m: string) => log?.debug(m),
    info:  (m: string) => log?.info(m),
    warn:  (m: string) => log?.warn(m),
    error: (m: string) => log?.error(m),
  };

  const client = new AiBot.WSClient({
    botId: cfg.botId,
    secret: cfg.secret,
    wsUrl: cfg.endpoint,
    logger: sdkLog,
  });

  const frames = new Map<string, FrameEntry>();
  const handlers: Array<(m: WecomIncomingMessage) => void> = [];
  const errHandlers: Array<(e: unknown) => void> = [];

  // 探测 mime — 企微 downloadFile 返回的是 Buffer，没有 mime 字段
  function guessMime(url: string, fallback: string): string {
    const u = url.toLowerCase();
    if (u.includes(".png")) return "image/png";
    if (u.includes(".jpg") || u.includes(".jpeg")) return "image/jpeg";
    if (u.includes(".gif")) return "image/gif";
    if (u.includes(".webp")) return "image/webp";
    if (u.includes(".pdf")) return "application/pdf";
    return fallback;
  }

  client.on("message", (frame: WsFrame<BaseMessage>) => {
    const body = frame.body;
    if (!body) return;
    const chatId = body.chattype === "group" ? (body.chatid ?? "") : body.from.userid;
    if (!chatId) {
      log?.warn("message missing chatId", { msgid: body.msgid });
      return;
    }

    let text = "";
    const images: WecomImageAttachment[] = [];
    const files: WecomFileAttachment[] = [];
    let quote: WecomIncomingMessage["quote"] | undefined;

    // 文本类
    if (body.msgtype === "text") {
      const tb = body as TextMessage;
      text = tb.text?.content ?? "";
    }
    // 图片类
    else if (body.msgtype === "image") {
      const ib = body as BaseMessage & { image?: ImageContent };
      if (ib.image?.url) {
        images.push({
          msgtype: "image",
          url: ib.image.url,
          aeskey: ib.image.aeskey,
        });
      }
    }
    // 图文混排
    else if (body.msgtype === "mixed") {
      const mb = body as BaseMessage & { mixed?: MixedContent };
      const parts: string[] = [];
      for (const item of mb.mixed?.msg_item ?? []) {
        if (item.msgtype === "text" && item.text) {
          parts.push(item.text.content);
        } else if (item.msgtype === "image" && item.image) {
          images.push({
            msgtype: "image",
            url: item.image.url,
            aeskey: item.image.aeskey,
          });
        }
      }
      text = parts.join("\n");
    }
    // 文件
    else if (body.msgtype === "file") {
      const fb = body as BaseMessage & { file?: FileContent };
      if (fb.file?.url) {
        files.push({
          msgtype: "file",
          url: fb.file.url,
          aeskey: fb.file.aeskey,
        });
      }
    }
    // 语音/视频 — 当前不喂 pi，可扩展（语音已转文字 msgtype=voice 时 content 是文本）
    else if (body.msgtype === "voice") {
      const vb = body as BaseMessage & { voice?: { content?: string } };
      text = vb.voice?.content ?? "";
    }
    else {
      log?.debug("unhandled message type", { msgtype: body.msgtype, msgid: body.msgid });
      // 不返回；让下游决定如何处理（通常会回"暂不支持此类型"）
    }

    // 引用
    if (body.quote) {
      quote = {
        msgtype: body.quote.msgtype,
        text: body.quote.text?.content,
        imageUrl: body.quote.image?.url,
      };
      // 把引用文本拼到正文前
      if (quote.msgtype === "text" && quote.text) {
        text = `[引用] ${quote.text}\n\n${text}`;
      } else if (quote.msgtype === "image") {
        text = `[引用了一张图片]\n\n${text}`;
      }
    }

    // 完全空的内容（纯文件/纯语音转写失败）也照样进，让下游回个"未识别"
    const entry: FrameEntry = {
      msgId: body.msgid,
      chatId,
      chatType: body.chattype,
      fromUserId: body.from?.userid,
      text,
      images,
      files,
      quote,
      headers: { headers: frame.headers },
    };
    frames.set(body.msgid, entry);

    for (const h of handlers) {
      try {
        h({
          msgId: entry.msgId,
          chatId: entry.chatId,
          chatType: entry.chatType,
          fromUserId: entry.fromUserId,
          text: entry.text,
          images: entry.images,
          files: entry.files,
          quote: entry.quote,
        });
      } catch (e) {
        log?.error("message handler threw", e);
      }
    }
  });

  client.on("error", (err: Error) => {
    for (const h of errHandlers) {
      try { h(err); } catch { /* ignore */ }
    }
  });

  function lookup(msgId: string): FrameEntry | undefined {
    return frames.get(msgId);
  }

  return {
    async start() {
      client.connect();
    },

    async stop() {
      try { client.disconnect(); } catch { /* ignore */ }
      frames.clear();
    },

    async reply(target, text) {
      const e = lookup(target.msgId);
      if (!e) {
        log?.warn("reply skipped: unknown msgId (reply window may have expired)", { msgId: target.msgId });
        return;
      }
      const streamId = randomUUID();
      try {
        await client.replyStream(e.headers, streamId, text, true);
      } finally {
        frames.delete(target.msgId);
      }
    },

    async send(chatId, _chatType, text) {
      await client.sendMessage(chatId, {
        msgtype: "markdown",
        markdown: { content: text },
      });
    },

    startStream(target) {
      const e = lookup(target.msgId);
      if (!e) {
        throw new Error(`startStream: unknown msgId ${target.msgId}`);
      }
      const streamId = randomUUID();
      let closed = false;

      const stream: WecomReplyStream = {
        streamId,
        async push(content, opts) {
          if (closed) return;
          const finish = opts?.finish ?? false;
          try {
            if (!finish) {
              await client.replyStreamNonBlocking(e.headers, streamId, content, false);
            } else {
              await client.replyStream(e.headers, streamId, content, true);
            }
          } catch (err) {
            log?.warn("replyStream failed", err);
            throw err;
          }
        },
        async close() {
          if (closed) return;
          closed = true;
          frames.delete(target.msgId);
        },
      };
      return stream;
    },

    /** 下载并解密某条消息的图片 — 同一消息可重复调用，会缓存 */
    async downloadImage(msgId: string, imageIndex = 0): Promise<{ mimeType: string; base64: string }> {
      const e = lookup(msgId);
      if (!e) throw new Error(`downloadImage: unknown msgId ${msgId}`);
      const att = e.images[imageIndex];
      if (!att) throw new Error(`downloadImage: no image at index ${imageIndex}`);
      if (att.downloaded) return att.downloaded;

      const { buffer } = await client.downloadFile(att.url, att.aeskey);
      const mimeType = guessMime(att.url, "image/jpeg");
      const base64 = buffer.toString("base64");
      const result = { mimeType, base64 };
      att.downloaded = result;
      return result;
    },

    async downloadFile_(msgId: string, fileIndex = 0): Promise<{ mimeType: string; base64: string }> {
      const e = lookup(msgId);
      if (!e) throw new Error(`downloadFile: unknown msgId ${msgId}`);
      const att = e.files[fileIndex];
      if (!att) throw new Error(`downloadFile: no file at index ${fileIndex}`);
      if (att.downloaded) return att.downloaded;

      const { buffer } = await client.downloadFile(att.url, att.aeskey);
      const mimeType = guessMime(att.url, "application/octet-stream");
      const base64 = buffer.toString("base64");
      const result = { mimeType, base64 };
      att.downloaded = result;
      return result;
    },

    onMessage(h) { handlers.push(h); },
    onError(h)   { errHandlers.push(h); },
  };
}