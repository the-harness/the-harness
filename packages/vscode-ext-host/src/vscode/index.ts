import type { ExtHostBridge } from "./bridge.ts";
import { createAuthenticationNamespace } from "./authentication.ts";
import { createCommandsNamespace, registerOpenCommand } from "./commands.ts";
import { createCommentsNamespace } from "./comments.ts";
import type { CommentsContributions } from "../comments-types.ts";
import { createChatNamespace } from "./chat.ts";
import { createDebugNamespace } from "./debug.ts";
import { registerDefinitionCommands } from "./definition-commands.ts";
import { registerDocumentSymbolCommand } from "./document-symbol-command.ts";
import { registerSelectionRangeCommand } from "./selection-range-command.ts";
import { createEnvNamespace } from "./env.ts";
import { createExtensionsNamespace } from "./extensions.ts";
import { registerFormattingCommands } from "./formatting-commands.ts";
import { registerHoverCommand } from "./hover-command.ts";
import { createLanguagesNamespace, Diagnostic, DiagnosticSeverity } from "./languages.ts";
import { registerLinkCommand } from "./link-command.ts";
import { l10n } from "./localization.ts";
import { createLmNamespace } from "./lm.ts";
import { registerSemanticTokenCommands } from "./semantic-token-commands.ts";
import { createScmNamespace } from "./scm.ts";
import { registerSignatureHelpCommand } from "./signature-help-command.ts";
import { createTasksNamespace, ShellExecution, Task } from "./tasks.ts";
import { createTypeHierarchyApi } from "./type-hierarchy.ts";
import * as valueTypes from "./types.ts";
import { createWindowNamespace } from "./window.ts";
import { createWorkspaceNamespace } from "./workspace.ts";
import { createWorkspaceEncoding } from "./workspace-encoding.ts";

export function createVscodeApi(bridge: ExtHostBridge) {
  const env = createEnvNamespace(bridge);
  const workspace = createWorkspaceNamespace(bridge);
  registerSelectionRangeCommand(bridge, workspace.openTextDocument);
  const window = createWindowNamespace(bridge, env, workspace.openTextDocument);
  registerHoverCommand(bridge, workspace.openTextDocument);
  registerOpenCommand(bridge, window.showTextDocument);
  registerDefinitionCommands(bridge, workspace.openTextDocument);
  registerDocumentSymbolCommand(bridge, workspace.openTextDocument);
  registerFormattingCommands(bridge, workspace.openTextDocument);
  const lm = createLmNamespace(bridge);
  registerSemanticTokenCommands(bridge, workspace.openTextDocument);
  const extensions = createExtensionsNamespace(bridge);
  const languages = createLanguagesNamespace(bridge, workspace.applyEdit, {
    getActiveDocument: () => window.activeTextEditor?.document,
    onDidChangeActiveEditor: window.onDidChangeActiveTextEditor,
  });
  registerSignatureHelpCommand(bridge, workspace.openTextDocument);
  const commands = createCommandsNamespace(bridge, () => window.activeTextEditor);
  registerLinkCommand(bridge, workspace.openTextDocument);
  return {
    ...valueTypes,
    version: "1.146.0",
    Diagnostic,
    DiagnosticSeverity,
    ShellExecution,
    Task,
    authentication: createAuthenticationNamespace(bridge),
    commands,
    comments: createCommentsNamespace(
      bridge,
      () =>
        extensions.all.find((extension) => extension.extensionPath === bridge.getExtensionPath?.())
          ?.packageJSON.contributes as CommentsContributions | undefined,
    ),
    chat: createChatNamespace(bridge, window),
    debug: createDebugNamespace(bridge),
    env,
    extensions,
    languages: {
      ...languages,
      ...createTypeHierarchyApi(bridge, workspace.openTextDocument, languages.match),
    },
    lm,
    l10n,
    scm: createScmNamespace(bridge, commands.executeCommand),
    tasks: createTasksNamespace(bridge, window.showQuickPick, languages),
    window,
    workspace: Object.assign(
      workspace,
      createWorkspaceEncoding(workspace.getConfiguration, () =>
        workspace.workspaceFolders.map((folder) => folder.uri),
      ),
    ),
  };
}
