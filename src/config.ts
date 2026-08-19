import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";

export interface WecomConfig {
  botId: string;
  secret: string;
  endpoint: string;
}

export interface PiConfig {
  workspaceRoot: string;
  perChatWorkspace: boolean;
  provider: string;
  model: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  agentDir: string;
  tools: string[];
  excludeTools: string[];
}

export interface RuntimeConfig {
  logLevel: "debug" | "info" | "warn" | "error";
  pidFile: string;
  streamingReply: boolean;
  streamingMinIntervalMs: number;
  maxReplyChars: number;
  /** 思考过程展示模式 */
  thinkingMode: "off" | "folded" | "separate";
  /** 思考摘要最大字符数（超出按尾部优先截断；folded 用于前缀，separate 用于独立消息） */
  thinkingMaxChars: number;
}

export interface AppConfig {
  wecom: WecomConfig;
  pi: PiConfig;
  runtime: RuntimeConfig;
  /** 调试用：实际加载到的配置文件绝对路径 */
  _loadedFrom?: string;
}

export interface LoadConfigOptions {
  /** 显式指定的配置文件路径（绝对或相对 cwd），最高优先级 */
  explicit?: string;
  /** cwd，默认 process.cwd() */
  cwd?: string;
}

export async function loadConfig(pathOrOpts?: string | LoadConfigOptions): Promise<AppConfig> {
  const opts: LoadConfigOptions =
    typeof pathOrOpts === "string" || pathOrOpts === undefined
      ? { explicit: typeof pathOrOpts === "string" ? pathOrOpts : undefined }
      : pathOrOpts;
  const cwd = opts.cwd ?? process.cwd();

  const candidates: string[] = [];
  if (opts.explicit) candidates.push(resolve(cwd, opts.explicit));
  else {
    if (process.env.ENVOY_CONFIG) candidates.push(resolve(cwd, process.env.ENVOY_CONFIG));
    candidates.push(resolve(cwd, "config.local.yaml"));
    candidates.push(resolve(cwd, "config.yaml"));
  }

  let picked: string | undefined;
  for (const p of candidates) {
    try {
      await access(p);
      picked = p;
      break;
    } catch {
      /* not found, try next */
    }
  }
  if (!picked) {
    throw new Error(
      `config not found; tried:\n${candidates.map((p) => "  - " + p).join("\n")}\n` +
      `Create config.local.yaml (gitignored) or set ENVOY_CONFIG env var.`,
    );
  }

  const raw = await readFile(picked, "utf8");
  const parsed = YAML.parse(raw) as Partial<AppConfig> & {
    runtime?: Partial<AppConfig["runtime"]> & { thinkingFolded?: boolean; thinkingMaxChars?: number };
  };

  // 旧配置兼容：thinkingFolded=true → thinkingMode="folded"，并提示迁移
  if (parsed.runtime?.thinkingFolded !== undefined && parsed.runtime?.thinkingMode === undefined) {
    // eslint-disable-next-line no-console
    console.warn(
      `[envoy] runtime.thinkingFolded 已废弃，请改用 thinkingMode: ${parsed.runtime.thinkingFolded ? '"folded"' : '"off"'}`,
    );
    parsed.runtime.thinkingMode = parsed.runtime.thinkingFolded ? "folded" : "off";
  }

  const cfg: AppConfig = {
    wecom: {
      botId: parsed.wecom?.botId ?? "",
      secret: parsed.wecom?.secret ?? "",
      endpoint: parsed.wecom?.endpoint ?? "wss://openws.work.weixin.qq.com",
    },
    pi: {
      workspaceRoot: resolve(parsed.pi?.workspaceRoot ?? "./workspace"),
      perChatWorkspace: parsed.pi?.perChatWorkspace ?? true,
      provider: parsed.pi?.provider ?? "",
      model: parsed.pi?.model ?? "",
      thinkingLevel: parsed.pi?.thinkingLevel ?? "medium",
      agentDir: parsed.pi?.agentDir ?? "",
      tools: parsed.pi?.tools ?? [],
      excludeTools: parsed.pi?.excludeTools ?? [],
    },
    runtime: {
      logLevel: parsed.runtime?.logLevel ?? "info",
      pidFile: resolve(parsed.runtime?.pidFile ?? "./.envoy.pid"),
      streamingReply: parsed.runtime?.streamingReply ?? true,
      streamingMinIntervalMs: parsed.runtime?.streamingMinIntervalMs ?? 400,
      maxReplyChars: parsed.runtime?.maxReplyChars ?? 4000,
      thinkingMode: parsed.runtime?.thinkingMode ?? "off",
      thinkingMaxChars: parsed.runtime?.thinkingMaxChars ?? 1000,
    },
  };

  if (!cfg.wecom.botId || !cfg.wecom.secret) {
    throw new Error(`${picked}: wecom.botId and wecom.secret are required`);
  }
  cfg._loadedFrom = picked;
  return cfg;
}