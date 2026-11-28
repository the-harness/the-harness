import { CwdService } from "@harness/cwd";
import { inject } from "@harness/di";
import { extractApplyPatchCommand, type ApplyPatchCommand } from "./exec.ts";
import { parsePatch } from "./parse.ts";
import { applyPatch, formatPatchSummary, verifyPatch } from "./verify.ts";
import type { ApplyPatchFileChange, VerifiedPatch } from "./types.ts";

export class CodexApplyPatchService {
  readonly #cwdService = inject(CwdService);

  verify(text: string, cwd: string = this.#cwdService.cwd): VerifiedPatch {
    return verifyPatch(parsePatch(text), cwd);
  }

  apply(verified: VerifiedPatch): readonly ApplyPatchFileChange[] {
    return applyPatch(verified);
  }

  formatSummary(changes: readonly ApplyPatchFileChange[]): string {
    return formatPatchSummary(changes);
  }

  extractCommand(command: string, cwd: string = this.#cwdService.cwd): ApplyPatchCommand | undefined {
    return extractApplyPatchCommand(command, cwd);
  }
}
