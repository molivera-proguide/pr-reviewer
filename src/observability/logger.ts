export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  readonly event: string;
  readonly reviewId?: string;
  readonly provider?: string;
  readonly changeRequest?: number;
  readonly stage?: string;
  readonly role?: string;
  readonly model?: string;
  readonly sliceId?: string;
  readonly attempt?: number;
  readonly failureKind?: string;
  readonly requestId?: string;
  readonly stopReason?: string;
  readonly statusCode?: number;
  readonly durationMs?: number;
  readonly counts?: Readonly<Record<string, number>>;
  readonly reason?: string;
}

function safeIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const sanitized = value.replace(/[^A-Za-z0-9_.:\\/-]/g, "_").slice(0, 256);
  return sanitized.length === 0 ? undefined : sanitized;
}

function safeRequestId(value: string | undefined): string | undefined {
  const sanitized = safeIdentifier(value);
  return sanitized !== undefined && /^req[_-][A-Za-z0-9_.:-]+$/.test(sanitized)
    ? sanitized
    : undefined;
}

export function sanitizeLogEvent(event: LogEvent): LogEvent {
  const reviewId = safeIdentifier(event.reviewId);
  const provider = safeIdentifier(event.provider);
  const stage = safeIdentifier(event.stage);
  const role = safeIdentifier(event.role);
  const model = safeIdentifier(event.model);
  const sliceId = safeIdentifier(event.sliceId);
  const failureKind = safeIdentifier(event.failureKind);
  const requestId = safeRequestId(event.requestId);
  const stopReason = safeIdentifier(event.stopReason);
  const reason = safeIdentifier(event.reason);
  return {
    event: safeIdentifier(event.event) ?? "invalid_event",
    ...(reviewId === undefined ? {} : { reviewId }),
    ...(provider === undefined ? {} : { provider }),
    ...(event.changeRequest === undefined ? {} : { changeRequest: event.changeRequest }),
    ...(stage === undefined ? {} : { stage }),
    ...(role === undefined ? {} : { role }),
    ...(model === undefined ? {} : { model }),
    ...(sliceId === undefined ? {} : { sliceId }),
    ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
    ...(failureKind === undefined ? {} : { failureKind }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(event.statusCode === undefined ? {} : { statusCode: event.statusCode }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.counts === undefined ? {} : { counts: event.counts }),
    ...(reason === undefined ? {} : { reason }),
  };
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
      ...sanitizeLogEvent(event),
    };
    Bun.stderr.write(`${JSON.stringify(safeEvent)}\n`);
  }
}

export class NullLogger implements Logger {
  log(_level: LogLevel, _event: LogEvent): void {}
}
