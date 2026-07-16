import type { ChangeRequestSummary } from "../domain/contracts.ts";

export interface RootInput {
  readonly repositoryPath?: string;
  readonly clientRoots?: readonly string[];
}

export interface DoctorCheck {
  readonly name: string;
  readonly status: "ok" | "warning" | "error";
  readonly detail: string;
}

export interface DoctorResult {
  readonly version: string;
  readonly platform: string;
  readonly root: string | null;
  readonly provider: "github" | "gitlab" | null;
  readonly repository: string | null;
  readonly overall: "ok" | "warning" | "error";
  readonly checks: readonly DoctorCheck[];
}

export interface ListResult {
  readonly provider: "github" | "gitlab";
  readonly repository: string;
  readonly root: string;
  readonly changeRequests: readonly ChangeRequestSummary[];
}

export type ReviewProgress = (stage: string, progress: number) => Promise<void> | void;
