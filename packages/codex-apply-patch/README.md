```ts
interface ApplyPatchFileChange {
  readonly path: string; // 补丁中的路径拼写；移动时仍为源路径
  readonly kind: "add" | "delete" | "update";
  readonly moveTo?: string; // 移动目标在补丁中的拼写
}

class ApplyPatchError extends Error {} // message 为 codex 原文，不含 "apply_patch verification failed: " 前缀

interface ApplyPatchCommand {
  readonly patch: string; // heredoc 中的补丁体
  readonly cwd: string; // `cd <dir> &&` 生效后的工作目录
}

interface VerifiedPatch {
  readonly cwd: string; // 解析相对路径所用的工作目录
  readonly changes: readonly VerifiedFileChange[]; // 按补丁顺序
}

class CodexApplyPatchService {
  verify(text: string, cwd?: string): VerifiedPatch; // parse + 只读 dry run，失败抛 ApplyPatchError；cwd 默认取 CwdService.cwd
  apply(verified: VerifiedPatch): readonly ApplyPatchFileChange[]; // 按补丁顺序落盘，无事务、不回滚；空补丁抛 "No files were modified."
  formatSummary(changes: readonly ApplyPatchFileChange[]): string; // "Success. Updated the following files:\nA ...\nM ...\nD ...\n"
  extractCommand(command: string, cwd?: string): ApplyPatchCommand | undefined; // 识别 heredoc 形式的 apply_patch；裸补丁命令抛 ApplyPatchError
}
```
