/** Minimal leveled logger; one line per event, callId-scoped where available. */

type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: Level = (process.env.LOG_LEVEL as Level) || "info";

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (order[level] < order[minLevel]) {
    return;
  }
  const ts = new Date().toISOString();
  const tail = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${tail}`;
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit("debug", scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit("info", scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit("warn", scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit("error", scope, msg, extra),
  };
}

export type Logger = ReturnType<typeof logger>;
