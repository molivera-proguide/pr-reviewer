import type {
  AuthStatus,
  ChangeRequestSnapshot,
  ChangeRequestSummary,
  RepositoryIdentity,
  SnapshotFile,
  TreeEntry,
} from "../domain/contracts.ts";

export interface RepositoryProvider {
  readonly kind: "github" | "gitlab";
  checkAuthentication(signal: AbortSignal): Promise<AuthStatus>;
  identifyRepository(signal: AbortSignal): Promise<RepositoryIdentity>;
  listOpenChangeRequests(limit: number, signal: AbortSignal): Promise<ChangeRequestSummary[]>;
  getChangeRequest(number: number, signal: AbortSignal): Promise<ChangeRequestSnapshot>;
  getCurrentHeadSha(number: number, signal: AbortSignal): Promise<string>;
  listTree(revision: string, prefix: string, signal: AbortSignal): Promise<TreeEntry[]>;
  readTextFile(revision: string, path: string, signal: AbortSignal): Promise<SnapshotFile>;
}

export interface ProviderLimits {
  readonly maxFiles: number;
  readonly maxDiffBytes: number;
  readonly maxFileBytes: number;
}
