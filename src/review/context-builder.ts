import type { Artifact, ChangeRequestSnapshot, FeatureReference } from "../domain/contracts.ts";
import { isSensitivePath, redactSecrets } from "../security/redaction.ts";

export interface ReviewContext {
  readonly snapshot: ChangeRequestSnapshot;
  readonly feature: FeatureReference;
  readonly artifacts: readonly Artifact[];
  readonly limitations: readonly string[];
}

export function buildReviewContext(
  snapshot: ChangeRequestSnapshot,
  feature: FeatureReference,
  artifacts: readonly Artifact[],
): ReviewContext {
  const limitations: string[] = [];
  const files = snapshot.files.map((file) => {
    if (isSensitivePath(file.path)) {
      limitations.push(`Sensitive path excluded: ${file.path}`);
      return {
        ...file,
        headContent: null,
        baseContent: null,
        patch: file.patch === null ? null : redactSecrets(file.patch),
        truncated: true,
      };
    }
    if (file.truncated) {
      limitations.push(`Changed file truncated: ${file.path}`);
    }
    if (file.binary) {
      limitations.push(`Binary or unavailable diff: ${file.path}`);
    }
    return {
      ...file,
      patch: file.patch === null ? null : redactSecrets(file.patch),
      headContent: file.headContent === null ? null : redactSecrets(file.headContent),
      baseContent: file.baseContent === null ? null : redactSecrets(file.baseContent),
    };
  });
  for (const artifact of artifacts) {
    if (artifact.status !== "loaded") {
      limitations.push(`Artifact ${artifact.path}: ${artifact.status}`);
    }
  }
  return {
    snapshot: { ...snapshot, diff: redactSecrets(snapshot.diff), files },
    feature,
    artifacts,
    limitations: [...new Set(limitations)],
  };
}
