import codeExplorer from "../../../prompts/code-explorer.md" with { type: "text" };
import sddExplorer from "../../../prompts/sdd-explorer.md" with { type: "text" };
import security from "../../../prompts/shared/security.md" with { type: "text" };
import synthesizer from "../../../prompts/synthesizer.md" with { type: "text" };
import verifier from "../../../prompts/verifier.md" with { type: "text" };

export const PROMPTS = {
  sddExplorer: `${security}\n\n${sddExplorer}`,
  codeExplorer: `${security}\n\n${codeExplorer}`,
  verifier: `${security}\n\n${verifier}`,
  synthesizer: `${security}\n\n${synthesizer}`,
} as const;
