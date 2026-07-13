export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  readonly event: string;
  readonly reviewId?: string;
  readonly provider?: string;
  readonly changeRequest?: number;
  readonly stage?: string;
  readonly durationMs?: number;
  readonly counts?: Readonly<Record<string, number>>;
  readonly reason?: string;
}

export interface Logger {
  log(level: LogLevel, event: LogEvent): void;
}

export class StderrLogger implements Logger {
  constructor(private readonly debugEnabled = false) {}

  log(level: LogLevel, event: LogEvent): void {
    if (level === "debug" && !this.debugEnabled) {
      return;
    }
    const safeEvent = {
      timestamp: new Date().toISOString(),
      level,
      ...event,
    };
    Bun.stderr.write(`${JSON.stringify(safeEvent)}\n`);
  }
}

export class NullLogger implements Logger {
  log(_level: LogLevel, _event: LogEvent): void {}
}
