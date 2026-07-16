import codeExplorer from "../../../prompts/code-explorer.md" with { type: "text" };
import coverageRepair from "../../../prompts/coverage-repair.md" with { type: "text" };
import sddExplorer from "../../../prompts/sdd-explorer.md" with { type: "text" };
import security from "../../../prompts/shared/security.md" with { type: "text" };
import testOnlyExplorer from "../../../prompts/test-only-explorer.md" with { type: "text" };
import verifier from "../../../prompts/verifier.md" with { type: "text" };

export const PROMPTS = {
  sddExplorer: `${security}\n\n${sddExplorer}`,
  codeExplorer: `${security}\n\n${codeExplorer}`,
  coverageRepair: `${security}\n\n${coverageRepair}`,
  testOnlyExplorer: `${security}\n\n${testOnlyExplorer}`,
  verifier: `${security}\n\n${verifier}`,
} as const;
