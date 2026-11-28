function numericEnum<const T extends Record<string, number>>(
  members: T,
): T & { readonly [value: number]: keyof T } {
  return Object.assign(
    {},
    members,
    Object.fromEntries(Object.entries(members).map(([key, value]) => [value, key])),
  ) as T & { readonly [value: number]: keyof T };
}

export const ChatLocation = numericEnum({ Panel: 1, Terminal: 2, Notebook: 3, Editor: 4 });
export type ChatLocation = 1 | 2 | 3 | 4;
export const ChatEditingSessionActionOutcome = numericEnum({ Accepted: 1, Rejected: 2, Saved: 3 });
export type ChatEditingSessionActionOutcome = 1 | 2 | 3;
export const ExcludeSettingOptions = numericEnum({
  None: 1,
  FilesExclude: 2,
  SearchAndFilesExclude: 3,
});
export type ExcludeSettingOptions = 1 | 2 | 3;
export const CommentMode = numericEnum({ Editing: 0, Preview: 1 });
export type CommentMode = 0 | 1;
export const CommentThreadCollapsibleState = numericEnum({ Collapsed: 0, Expanded: 1 });
export type CommentThreadCollapsibleState = 0 | 1;
export const CommentThreadState = numericEnum({ Unresolved: 0, Resolved: 1 });
export type CommentThreadState = 0 | 1;
export const CommentThreadFocus = numericEnum({ Reply: 1, Comment: 2 });
export type CommentThreadFocus = 1 | 2;
export const DebugConsoleMode = numericEnum({ Separate: 0, MergeWithParent: 1 });
export type DebugConsoleMode = 0 | 1;

export const StatusBarAlignment = numericEnum({
  Left: 1,
  Right: 2,
});
export type StatusBarAlignment = 1 | 2;

export const ProgressLocation = numericEnum({
  SourceControl: 1,
  Window: 10,
  Notification: 15,
});
export type ProgressLocation = 1 | 10 | 15;

export const ViewColumn = numericEnum({
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
  Three: 3,
  Four: 4,
  Five: 5,
  Six: 6,
  Seven: 7,
  Eight: 8,
  Nine: 9,
});
export type ViewColumn = -2 | -1 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export const TreeItemCollapsibleState = numericEnum({
  None: 0,
  Collapsed: 1,
  Expanded: 2,
});
export type TreeItemCollapsibleState = 0 | 1 | 2;

export const FileType = numericEnum({
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
});
export type FileType = 0 | 1 | 2 | 64;

export const EndOfLine = numericEnum({
  LF: 1,
  CRLF: 2,
});
export type EndOfLine = 1 | 2;

export const ConfigurationTarget = numericEnum({
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
});
export type ConfigurationTarget = 1 | 2 | 3;

export const ExtensionMode = numericEnum({
  Production: 1,
  Development: 2,
  Test: 3,
});
export type ExtensionMode = 1 | 2 | 3;

export const ExtensionKind = numericEnum({
  UI: 1,
  Workspace: 2,
});
export type ExtensionKind = 1 | 2;

export const CompletionItemKind = numericEnum({
  Text: 0,
  Method: 1,
  Function: 2,
  Constructor: 3,
  Field: 4,
  Variable: 5,
  Class: 6,
  Interface: 7,
  Module: 8,
  Property: 9,
  Unit: 10,
  Value: 11,
  Enum: 12,
  Keyword: 13,
  Snippet: 14,
  Color: 15,
  File: 16,
  Reference: 17,
  Folder: 18,
  EnumMember: 19,
  Constant: 20,
  Struct: 21,
  Event: 22,
  Operator: 23,
  TypeParameter: 24,
  User: 25,
  Issue: 26,
});
export type CompletionItemKind =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24
  | 25
  | 26;

export const SymbolKind = numericEnum({
  File: 0,
  Module: 1,
  Namespace: 2,
  Package: 3,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  String: 14,
  Number: 15,
  Boolean: 16,
  Array: 17,
  Object: 18,
  Key: 19,
  Null: 20,
  EnumMember: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
});
export type SymbolKind =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24
  | 25;

export const DiagnosticSeverity = numericEnum({
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
});
export type DiagnosticSeverity = 0 | 1 | 2 | 3;

export const LanguageStatusSeverity = numericEnum({
  Information: 0,
  Warning: 1,
  Error: 2,
});
export type LanguageStatusSeverity = 0 | 1 | 2;

export const DiagnosticTag = numericEnum({
  Unnecessary: 1,
  Deprecated: 2,
});
export type DiagnosticTag = 1 | 2;

export const CompletionItemTag = numericEnum({
  Deprecated: 1,
});
export type CompletionItemTag = 1;

export const CompletionTriggerKind = numericEnum({
  Invoke: 0,
  TriggerCharacter: 1,
  TriggerForIncompleteCompletions: 2,
});
export type CompletionTriggerKind = 0 | 1 | 2;

export const CodeActionTriggerKind = numericEnum({
  Invoke: 1,
  Automatic: 2,
});
export type CodeActionTriggerKind = 1 | 2;

export const DocumentHighlightKind = numericEnum({
  Text: 0,
  Read: 1,
  Write: 2,
});
export type DocumentHighlightKind = 0 | 1 | 2;

export const SymbolTag = numericEnum({
  Deprecated: 1,
});
export type SymbolTag = 1;

export const IndentAction = numericEnum({ None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 });
export type IndentAction = 0 | 1 | 2 | 3;
export const SyntaxTokenType = numericEnum({ Other: 0, Comment: 1, String: 2, RegEx: 3 });
export type SyntaxTokenType = 0 | 1 | 2 | 3;

export const FoldingRangeKind = numericEnum({
  Comment: 1,
  Imports: 2,
  Region: 3,
});
export type FoldingRangeKind = 1 | 2 | 3;

export const InlayHintKind = numericEnum({
  Type: 1,
  Parameter: 2,
});
export type InlayHintKind = 1 | 2;

export const SignatureHelpTriggerKind = numericEnum({
  Invoke: 1,
  TriggerCharacter: 2,
  ContentChange: 3,
});
export type SignatureHelpTriggerKind = 1 | 2 | 3;

export const InlineCompletionTriggerKind = numericEnum({
  Invoke: 0,
  Automatic: 1,
});
export type InlineCompletionTriggerKind = 0 | 1;

export const TextDocumentChangeReason = numericEnum({
  Undo: 1,
  Redo: 2,
});
export type TextDocumentChangeReason = 1 | 2;

export const TextDocumentSaveReason = numericEnum({
  Manual: 1,
  AfterDelay: 2,
  FocusOut: 3,
});
export type TextDocumentSaveReason = 1 | 2 | 3;

export const TextEditorSelectionChangeKind = numericEnum({
  Keyboard: 1,
  Mouse: 2,
  Command: 3,
});
export type TextEditorSelectionChangeKind = 1 | 2 | 3;

export const TextEditorCursorStyle = numericEnum({
  Line: 1,
  Block: 2,
  Underline: 3,
  LineThin: 4,
  BlockOutline: 5,
  UnderlineThin: 6,
});
export type TextEditorCursorStyle = 1 | 2 | 3 | 4 | 5 | 6;

export const TextEditorLineNumbersStyle = numericEnum({
  Off: 0,
  On: 1,
  Relative: 2,
  Interval: 3,
});
export type TextEditorLineNumbersStyle = 0 | 1 | 2 | 3;

export const TextEditorRevealType = numericEnum({
  Default: 0,
  InCenter: 1,
  InCenterIfOutsideViewport: 2,
  AtTop: 3,
});
export type TextEditorRevealType = 0 | 1 | 2 | 3;

export const OverviewRulerLane = numericEnum({
  Left: 1,
  Center: 2,
  Right: 4,
  Full: 7,
});
export type OverviewRulerLane = 1 | 2 | 4 | 7;

export const DecorationRangeBehavior = numericEnum({
  OpenOpen: 0,
  ClosedClosed: 1,
  OpenClosed: 2,
  ClosedOpen: 3,
});
export type DecorationRangeBehavior = 0 | 1 | 2 | 3;

export const FilePermission = numericEnum({
  Readonly: 1,
});
export type FilePermission = 1;

export const FileChangeType = numericEnum({
  Changed: 1,
  Created: 2,
  Deleted: 3,
});
export type FileChangeType = 1 | 2 | 3;

export const QuickPickItemKind = numericEnum({
  Separator: -1,
  Default: 0,
});
export type QuickPickItemKind = -1 | 0;

export const InputBoxValidationSeverity = numericEnum({
  Info: 1,
  Warning: 2,
  Error: 3,
});
export type InputBoxValidationSeverity = 1 | 2 | 3;

export const UIKind = numericEnum({
  Desktop: 1,
  Web: 2,
});
export type UIKind = 1 | 2;

export const ColorThemeKind = numericEnum({
  Light: 1,
  Dark: 2,
  HighContrast: 3,
  HighContrastLight: 4,
});
export type ColorThemeKind = 1 | 2 | 3 | 4;

export interface ColorTheme {
  readonly kind: ColorThemeKind;
}

export const TerminalLocation = numericEnum({
  Panel: 1,
  Editor: 2,
});
export type TerminalLocation = 1 | 2;

export const TerminalExitReason = numericEnum({
  Unknown: 0,
  Shutdown: 1,
  Process: 2,
  User: 3,
  Extension: 4,
});
export type TerminalExitReason = 0 | 1 | 2 | 3 | 4;

export const TerminalShellExecutionCommandLineConfidence = numericEnum({
  Low: 0,
  Medium: 1,
  High: 2,
});
export type TerminalShellExecutionCommandLineConfidence = 0 | 1 | 2;

export const TaskScope = numericEnum({
  Global: 1,
  Workspace: 2,
});
export type TaskScope = 1 | 2;

export const TaskRevealKind = numericEnum({
  Always: 1,
  Silent: 2,
  Never: 3,
});
export type TaskRevealKind = 1 | 2 | 3;

export const TaskPanelKind = numericEnum({
  Shared: 1,
  Dedicated: 2,
  New: 3,
});
export type TaskPanelKind = 1 | 2 | 3;

export const ShellQuoting = numericEnum({
  Escape: 1,
  Strong: 2,
  Weak: 3,
});
export type ShellQuoting = 1 | 2 | 3;

export const LogLevel = numericEnum({
  Off: 0,
  Trace: 1,
  Debug: 2,
  Info: 3,
  Warning: 4,
  Error: 5,
});
export type LogLevel = 0 | 1 | 2 | 3 | 4 | 5;

export const TreeItemCheckboxState = numericEnum({
  Unchecked: 0,
  Checked: 1,
});
export type TreeItemCheckboxState = 0 | 1;

export const TextEditorChangeKind = numericEnum({ Addition: 1, Deletion: 2, Modification: 3 });
export type TextEditorChangeKind = 1 | 2 | 3;
export const ExternalUriOpenerPriority = numericEnum({
  None: 0,
  Option: 1,
  Default: 2,
  Preferred: 3,
});
export type ExternalUriOpenerPriority = 0 | 1 | 2 | 3;
