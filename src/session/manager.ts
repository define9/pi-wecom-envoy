/**
 * Session Manager
 *
 * 按 (chatType, chatId, userId) 三元组隔离 AgentSession。
 *   - single: chatId == userId
 *   - group:  chatId 群 ID；userId 群内发言人；会话按 chatId 共享
 *
 * 每个 session 的 cwd = workspaceRoot/<subdir>。
 * pi SDK 会自动加载该 cwd 下的 AGENTS.md / .pi/settings.json / skills / extensions。
 *
 * 实现细节：
 *   - 首次 acquire 时创建 AgentSession 并落盘（SessionManager.create）
 *   - 后续 acquire 直接复用
 *   - LRU 上限避免长时间运行内存膨胀
 */

import { mkdir } from "node:fs/promises";
import { join, resolve as pathResolve } from "node:path";
import {
  createAgentSession,
  type AgentSession,
  ModelRuntime,
  SessionManager as PiSessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

import type { PiConfig } from "../config.js";
import type { Logger } from "../log.js";

export interface SessionKey {
  chatType: "single" | "group";
  chatId: string;
  userId?: string;
}

function keyString(k: SessionKey): string {
  return k.chatType === "single" ? `s:${k.chatId}` : `g:${k.chatId}`;
}

function cwdFor(root: string, k: SessionKey, perChat: boolean): string {
  if (!perChat) return pathResolve(root);
  const sub = k.chatType === "single" ? `single-${k.chatId}` : `group-${k.chatId}`;
  return pathResolve(root, sub);
}

interface Entry {
  key: SessionKey;
  keyStr: string;
  cwd: string;
  session: AgentSession;
  unsubscribe: () => void;
  lastUsed: number;
  promptInFlight: Promise<void> | null;
}

export class SessionRegistry {
  private entries = new Map<string, Entry>();
  private modelRuntime: ModelRuntime | null = null;
  private model: Model<any> | undefined;

  constructor(
    private cfg: PiConfig,
    private log: Logger,
    private maxEntries = 200,
  ) {}

  async init(modelRuntime: ModelRuntime, model: Model<any> | undefined): Promise<void> {
    this.modelRuntime = modelRuntime;
    this.model = model;
  }

  has(k: SessionKey): boolean {
    return this.entries.has(keyString(k));
  }

  async acquire(k: SessionKey): Promise<Entry> {
    const ks = keyString(k);
    const existing = this.entries.get(ks);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }

    if (!this.modelRuntime) throw new Error("SessionRegistry.init() not called");

    const cwd = cwdFor(this.cfg.workspaceRoot, k, this.cfg.perChatWorkspace);
    await mkdir(cwd, { recursive: true });
    this.log.info("creating pi session", { key: ks, cwd });

    // SessionManager.create(cwd) 会自动落到 ~/.pi/agent/sessions/<hash>/<uuid>.jsonl
    // 想换目录请传 SessionManager.create(cwd, { sessionDir: ... })
    const sessionMgr = PiSessionManager.create(cwd);

    const createOpts: Parameters<typeof createAgentSession>[0] = {
      cwd,
      sessionManager: sessionMgr,
      modelRuntime: this.modelRuntime,
      thinkingLevel: this.cfg.thinkingLevel,
    };
    if (this.model) createOpts.model = this.model;
    if (this.cfg.tools.length > 0) createOpts.tools = this.cfg.tools as never;
    if (this.cfg.excludeTools.length > 0) createOpts.excludeTools = this.cfg.excludeTools as never;
    if (this.cfg.agentDir) createOpts.agentDir = this.cfg.agentDir;

    const { session } = await createAgentSession(createOpts);

    const unsubscribe = session.subscribe(() => {
      /* 事件在 caller 那边按需订阅；这里不做事 */
    });

    const entry: Entry = {
      key: k,
      keyStr: ks,
      cwd,
      session,
      unsubscribe,
      lastUsed: Date.now(),
      promptInFlight: null,
    };
    this.entries.set(ks, entry);
    this.evictIfNeeded();
    return entry;
  }

  get(k: SessionKey): Entry | undefined {
    return this.entries.get(keyString(k));
  }

  async dispose(k: SessionKey): Promise<void> {
    const ks = keyString(k);
    const e = this.entries.get(ks);
    if (!e) return;
    this.entries.delete(ks);
    try { e.unsubscribe(); } catch { /* ignore */ }
    try { e.session.dispose(); } catch { /* ignore */ }
  }

  async disposeAll(): Promise<void> {
    const all = Array.from(this.entries.values());
    this.entries.clear();
    await Promise.all(all.map(async (e) => {
      try { e.unsubscribe(); } catch { /* ignore */ }
      try { e.session.dispose(); } catch { /* ignore */ }
    }));
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxEntries) return;
    const sorted = Array.from(this.entries.values()).sort((a, b) => a.lastUsed - b.lastUsed);
    const toEvict = sorted.slice(0, this.entries.size - this.maxEntries);
    for (const e of toEvict) {
      this.entries.delete(e.keyStr);
      try { e.unsubscribe(); } catch { /* ignore */ }
      try { e.session.dispose(); } catch { /* ignore */ }
      this.log.info("evicted idle session", { key: e.keyStr });
    }
  }
}

export function sessionKey(chatType: "single" | "group", chatId: string, userId?: string): SessionKey {
  return { chatType, chatId, userId };
}

/** 复用路径：将 workspace 路径转成可读的相对展示 */
export function displayPath(abs: string, root: string): string {
  const r = pathResolve(root);
  if (abs.startsWith(r)) {
    const rel = abs.slice(r.length).replace(/^[\\/]/, "");
    return rel ? join("workspace", rel) : "workspace";
  }
  return abs;
}