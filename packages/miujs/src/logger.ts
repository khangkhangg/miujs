export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  /** A logger that adds `fields` to every line. */
  child(fields: Record<string, unknown>): Logger;
}

export type LogSink = (line: Record<string, unknown>) => void;

const consoleSink: LogSink = (line) => {
  const text = JSON.stringify(line, errorReplacer);
  if (line.level === "error") console.error(text);
  else if (line.level === "warn") console.warn(text);
  else console.log(text);
};

function errorReplacer(_key: string, value: unknown) {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

/** JSON-lines logger: one object per line, easy for people to grep and for agents to parse. */
export function createLogger(level: LogLevel | "silent" = "info", fields: Record<string, unknown> = {}, sink: LogSink = consoleSink): Logger {
  const min = ORDER[level];
  const write = (lvl: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    sink({ level: lvl, time: new Date().toISOString(), msg, ...fields, ...data });
  };
  return {
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
    child: (more) => createLogger(level, { ...fields, ...more }, sink),
  };
}
