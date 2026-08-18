type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(private min: Level = "info") {}

  private emit(level: Level, msg: string, extra?: unknown) {
    if (ORDER[level] < ORDER[this.min]) return;
    const line = extra === undefined ? msg : `${msg} ${safeStringify(extra)}`;
    const tag = level.toUpperCase().padEnd(5);
    const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
    out.write(`[${nowIso()}] ${tag} ${line}\n`);
  }

  debug(msg: string, extra?: unknown) { this.emit("debug", msg, extra); }
  info(msg: string, extra?: unknown)  { this.emit("info", msg, extra); }
  warn(msg: string, extra?: unknown)  { this.emit("warn", msg, extra); }
  error(msg: string, extra?: unknown) { this.emit("error", msg, extra); }
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}