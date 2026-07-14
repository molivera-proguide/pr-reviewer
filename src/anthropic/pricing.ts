import type { AttemptSummary } from "../domain/contracts.ts";

const MILLION = 1_000_000;
const SONNET_PROMO_END = Date.parse("2026-09-01T00:00:00.000Z");

interface TokenRates {
  readonly baseInput: number;
  readonly cacheCreationInput: number;
  readonly cacheReadInput: number;
  readonly output: number;
}

export interface CostEstimate {
  readonly currency: "USD";
  readonly amount: number;
  readonly failedAttemptAmount: number;
  readonly pricingVersion: "anthropic-public-2026-07-14";
  readonly complete: boolean;
}

function ratesFor(model: string, createdAt: Date): TokenRates | null {
  if (model.startsWith("claude-haiku-4-5")) {
    return { baseInput: 1, cacheCreationInput: 1.25, cacheReadInput: 0.1, output: 5 };
  }
  if (model.startsWith("claude-sonnet-5")) {
    const promotional = createdAt.getTime() < SONNET_PROMO_END;
    const baseInput = promotional ? 2 : 3;
    return {
      baseInput,
      cacheCreationInput: baseInput * 1.25,
      cacheReadInput: baseInput * 0.1,
      output: promotional ? 10 : 15,
    };
  }
  return null;
}

function attemptCost(attempt: AttemptSummary, createdAt: Date): number | null {
  if (attempt.model === undefined) return null;
  const rates = ratesFor(attempt.model, createdAt);
  if (rates === null) return null;
  const cacheCreation = attempt.cacheCreationInputTokens ?? 0;
  const cacheRead = attempt.cacheReadInputTokens ?? 0;
  const baseInput =
    attempt.baseInputTokens ?? Math.max(0, attempt.inputTokens - cacheCreation - cacheRead);
  return (
    (baseInput * rates.baseInput +
      cacheCreation * rates.cacheCreationInput +
      cacheRead * rates.cacheReadInput +
      attempt.outputTokens * rates.output) /
    MILLION
  );
}

export function estimateReviewCost(
  attempts: readonly AttemptSummary[],
  createdAt: Date,
): CostEstimate {
  let amount = 0;
  let failedAttemptAmount = 0;
  let complete = true;
  for (const attempt of attempts) {
    const value = attemptCost(attempt, createdAt);
    if (value === null) {
      complete = false;
      continue;
    }
    amount += value;
    if (attempt.status === "failed") failedAttemptAmount += value;
  }
  return {
    currency: "USD",
    amount,
    failedAttemptAmount,
    pricingVersion: "anthropic-public-2026-07-14",
    complete,
  };
}
