import { ReviewerError } from "../domain/errors.ts";

export interface BudgetLimits {
  readonly maxCalls: number;
  readonly maxOutputTokens: number;
  readonly deadlineMs: number;
}

export class UsageBudget {
  readonly startedAt = Date.now();
  private calls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private nextReservationId = 1;
  private readonly reservations = new Map<number, number>();

  constructor(private readonly limits: BudgetLimits) {}

  reserveCall(estimatedOutputTokens: number): number {
    this.assertTimeRemaining();
    if (this.calls + 1 > this.limits.maxCalls) {
      throw new ReviewerError("BUDGET_EXCEEDED", "Anthropic call budget exhausted.");
    }
    const reservedOutputTokens = [...this.reservations.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    if (
      this.outputTokens + reservedOutputTokens + estimatedOutputTokens >
      this.limits.maxOutputTokens
    ) {
      throw new ReviewerError("BUDGET_EXCEEDED", "Anthropic output-token budget exhausted.");
    }
    this.calls += 1;
    const reservationId = this.nextReservationId;
    this.nextReservationId += 1;
    this.reservations.set(reservationId, estimatedOutputTokens);
    return reservationId;
  }

  recordUsage(inputTokens: number, outputTokens: number, reservationId?: number): void {
    if (reservationId === undefined) {
      const first = this.reservations.keys().next().value as number | undefined;
      if (first !== undefined) this.reservations.delete(first);
    } else {
      this.reservations.delete(reservationId);
    }
    this.inputTokens += Math.max(0, inputTokens);
    this.outputTokens += Math.max(0, outputTokens);
    if (this.outputTokens > this.limits.maxOutputTokens) {
      throw new ReviewerError("BUDGET_EXCEEDED", "Anthropic output-token budget was exceeded.");
    }
  }

  releaseReservation(reservationId: number): void {
    this.reservations.delete(reservationId);
  }

  assertTimeRemaining(): void {
    if (Date.now() - this.startedAt >= this.limits.deadlineMs) {
      throw new ReviewerError("TIMEOUT", "Review duration limit was reached.");
    }
  }

  snapshot(): { inputTokens: number; outputTokens: number; calls: number } {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      calls: this.calls,
    };
  }
}
