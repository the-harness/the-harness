import * as monaco from "monaco-editor";
import { StandaloneServices } from "monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js";
import { ILanguageFeaturesService } from "monaco-editor/esm/vs/editor/common/services/languageFeatures.js";
import { shallowRef } from "vue";
import type { ServiceIdentifier } from "@harness/di";
import { runInInjectionContext } from "../../../packages/di/src/instantiation.ts";
import {
  VscodeLanguagesCompatService,
  VscodeWorkspaceCompatService,
} from "@harness/vscode-editor-compat";
import {
  CancellationTokenSource,
  CodeActionKind,
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  Diagnostic,
  DiagnosticSeverity,
  Location,
  MarkdownString,
  Position,
  Range,
  SnippetString,
  TextDocumentData,
  TextEdit,
  Uri,
  WorkspaceEdit,
} from "../../../packages/vscode-types/src/index.ts";

type Registry<T> = { ordered(model: monaco.editor.ITextModel): T[] };

export async function observeLanguageConversions() {
  const uri = Uri.parse("vscode-remote://ssh-remote+fixture/fixture/main.ts?view=1#source");
  const target = Uri.parse("vscode-remote://ssh-remote+fixture/fixture/target.ts?view=2#target");
  const document = new TextDocumentData({
    uri: uri.toJSON(),
    text: "hello()\nworld",
    languageId: "plaintext",
    version: 4,
    isDirty: true,
    eol: 1,
  });
  const service = runInInjectionContext(
    {
      get<T>(id: ServiceIdentifier<T>): T {
        if (id === VscodeWorkspaceCompatService)
          return { textDocuments: shallowRef([document]) } as T;
        throw new Error("Unexpected language fixture dependency");
      },
    },
    () => new VscodeLanguagesCompatService(),
  );
  const features = StandaloneServices.get(ILanguageFeaturesService) as {
    completionProvider: Registry<monaco.languages.CompletionItemProvider>;
    definitionProvider: Registry<monaco.languages.DefinitionProvider>;
    inlineCompletionsProvider: Registry<monaco.languages.InlineCompletionsProvider>;
    codeActionProvider: Registry<
      monaco.languages.CodeActionProvider & { providedCodeActionKinds?: readonly string[] }
    >;
    signatureHelpProvider: Registry<monaco.languages.SignatureHelpProvider>;
    inlayHintsProvider: Registry<monaco.languages.InlayHintsProvider>;
    colorProvider: Registry<monaco.languages.DocumentColorProvider>;
  };
  const selector = [
    {
      language: "plaintext",
      scheme: "vscode-remote",
      pattern: {
        baseUri: Uri.parse("vscode-remote://ssh-remote+fixture/fixture"),
        pattern: "**/*.ts",
      },
    },
  ];
  const disposables: { dispose(): void }[] = [];
  const token = new CancellationTokenSource();
  const range = new Range(0, 0, 0, 5);
  const seen: Record<string, unknown> = {};
  const markdown = new MarkdownString("**documentation**");
  markdown.isTrusted = { enabledCommands: ["fixture.run"] };
  markdown.supportHtml = true;
  markdown.supportThemeIcons = true;
  markdown.baseUri = target;
  disposables.push(
    service.registerCompletionItemProvider(
      selector,
      {
        provideCompletionItems(doc, position, actualToken, context) {
          seen.completion = {
            identity: doc === document,
            text: doc.getText(),
            position: position.translate(0, 1),
            token: actualToken === token.token,
            context,
          };
          const item = new CompletionItem(
            { label: "hello", detail: "()", description: "fixture" },
            CompletionItemKind.Function,
          );
          item.insertText = new SnippetString("hello($1)");
          item.documentation = markdown;
          item.range = { inserting: range, replacing: new Range(0, 0, 0, 7) };
          item.additionalTextEdits = [TextEdit.insert(new Position(1, 0), "import hello;\n")];
          item.command = { command: "fixture.run", title: "Run", arguments: [42] };
          return new CompletionList([item], true);
        },
        resolveCompletionItem(item) {
          item.detail = "resolved";
          return item;
        },
      },
      ".",
    ),
  );
  disposables.push(
    service.registerDefinitionProvider(selector, {
      provideDefinition() {
        return [
          {
            targetUri: target,
            targetRange: new Range(1, 0, 3, 0),
            targetSelectionRange: new Range(1, 1, 1, 4),
            originSelectionRange: range,
          },
        ];
      },
    }),
  );
  disposables.push(
    service.registerInlineCompletionItemProvider(selector, {
      provideInlineCompletionItems(_doc, _position, context) {
        seen.inline = context;
        return {
          items: [
            {
              insertText: new SnippetString("hello($1)"),
              range,
              command: { title: "Run", command: "fixture.run" },
            },
          ],
        };
      },
    }),
  );
  disposables.push(
    service.registerCodeActionsProvider(
      selector,
      {
        provideCodeActions(doc, actualRange, context, actualToken) {
          seen.action = {
            identity: doc === document,
            contains: actualRange.contains(new Position(0, 1)),
            only: context.only?.value,
            trigger: context.triggerKind,
            diagnostics: context.diagnostics.map((diagnostic) => ({
              message: diagnostic.message,
              severity: diagnostic.severity,
              target:
                typeof diagnostic.code === "object" ? diagnostic.code.target.toString() : undefined,
            })),
            token: actualToken === token.token,
          };
          const edit = new WorkspaceEdit();
          edit.replace(uri, range, "fixed");
          return [
            {
              title: "Fix",
              kind: CodeActionKind.QuickFix,
              edit,
              disabled: { reason: "fixture" },
              isPreferred: true,
            },
          ];
        },
        resolveCodeAction(action) {
          return { ...action, command: { command: "fixture.run", title: "Resolved" } };
        },
      },
      { providedCodeActionKinds: [CodeActionKind.QuickFix] },
    ),
  );
  disposables.push(
    service.registerSignatureHelpProvider(
      selector,
      {
        provideSignatureHelp(_doc, _position, _token, context) {
          seen.signature = context;
          return {
            signatures: [
              {
                label: "hello(value)",
                documentation: markdown,
                parameters: [{ label: [6, 11], documentation: "value" }],
                activeParameter: 0,
              },
            ],
            activeSignature: 0,
            activeParameter: 0,
          };
        },
      },
      { triggerCharacters: ["("], retriggerCharacters: [","] },
    ),
  );
  let hintsReleased = 0;
  disposables.push(
    service.registerInlayHintsProvider(selector, {
      provideInlayHints() {
        const hints = [
          {
            position: new Position(0, 5),
            label: [
              {
                value: ": string",
                tooltip: markdown,
                location: new Location(target, range),
                command: { command: "fixture.run", title: "Run" },
              },
            ],
            kind: 1,
            textEdits: [TextEdit.insert(new Position(0, 5), ": string")],
            paddingLeft: true,
          },
        ];
        return Object.assign(hints, { dispose: () => hintsReleased++ });
      },
      resolveInlayHint(hint) {
        return { ...hint, tooltip: "resolved" };
      },
    }),
  );
  disposables.push(
    service.registerColorProvider(selector, {
      provideDocumentColors() {
        return [{ range, color: { red: 1, green: 0, blue: 0, alpha: 1 } }];
      },
      provideColorPresentations(color, context, actualToken) {
        seen.color = {
          red: color.red,
          identity: context.document === document,
          contains: context.range.contains(new Position(0, 1)),
          token: actualToken === token.token,
        };
        return [{ label: "red", textEdit: TextEdit.replace(range, "#f00") }];
      },
    }),
  );
  const first = service.createDiagnosticCollection("same-name");
  const second = service.createDiagnosticCollection("same-name");
  disposables.push(first, second);
  const diagnostic = new Diagnostic(range, "pending", DiagnosticSeverity.Warning);
  diagnostic.code = { value: 17, target };
  diagnostic.source = "fixture";
  diagnostic.relatedInformation = [{ location: new Location(target, range), message: "related" }];
  first.set(uri, [diagnostic]);
  second.set(uri, [new Diagnostic(range, "other", DiagnosticSeverity.Information)]);
  const model = monaco.editor.createModel(
    document.getText(),
    "plaintext",
    monaco.Uri.parse(uri.toString()),
  );
  const position = new monaco.Position(1, 3);
  const modelRange = new monaco.Range(1, 1, 1, 6);
  try {
    const completionProvider = features.completionProvider.ordered(model)[0]!;
    const completion = await completionProvider.provideCompletionItems(
      model,
      position,
      {
        triggerKind: monaco.languages.CompletionTriggerKind.TriggerCharacter,
        triggerCharacter: ".",
      },
      token.token,
    );
    const item = completion!.suggestions[0]!;
    const resolved = await completionProvider.resolveCompletionItem!(item, token.token);
    const definition = (await features.definitionProvider
      .ordered(model)[0]!
      .provideDefinition(model, position, token.token)) as monaco.languages.LocationLink[];
    const inlineProvider = features.inlineCompletionsProvider.ordered(model)[0]!;
    const inline = await inlineProvider.provideInlineCompletions(
      model,
      position,
      {
        triggerKind: monaco.languages.InlineCompletionTriggerKind.Explicit,
        selectedSuggestionInfo: new monaco.languages.SelectedSuggestionInfo(
          modelRange,
          "hello",
          monaco.languages.CompletionItemKind.Function,
          false,
        ),
      },
      token.token,
    );
    const actionProvider = features.codeActionProvider.ordered(model)[0]!;
    const actionList = await actionProvider.provideCodeActions(
      model,
      modelRange,
      { markers: [], only: "quickfix", trigger: monaco.languages.CodeActionTriggerType.Invoke },
      token.token,
    );
    const action = actionList!.actions[0]!;
    const actionResolved = await actionProvider.resolveCodeAction!(action, token.token);
    const signatureProvider = features.signatureHelpProvider.ordered(model)[0]!;
    const signatures = await signatureProvider.provideSignatureHelp(model, position, token.token, {
      triggerKind: monaco.languages.SignatureHelpTriggerKind.TriggerCharacter,
      triggerCharacter: "(",
      isRetrigger: true,
    });
    const hintProvider = features.inlayHintsProvider.ordered(model)[0]!;
    const hints = await hintProvider.provideInlayHints(model, modelRange, token.token);
    const hint = await hintProvider.resolveInlayHint!(hints!.hints[0]!, token.token);
    const releaseCount = hintsReleased;
    hints!.dispose();
    const releasesOnDispose = hintsReleased - releaseCount;
    const colors = await features.colorProvider
      .ordered(model)[0]!
      .provideColorPresentations(
        model,
        { range: modelRange, color: { red: 1, green: 0, blue: 0, alpha: 1 } },
        token.token,
      );
    const markers = monaco.editor.getModelMarkers({ resource: model.uri }).map((marker) => ({
      message: marker.message,
      severity: marker.severity,
      source: marker.source,
      code:
        typeof marker.code === "object"
          ? { value: marker.code.value, target: marker.code.target.toString() }
          : marker.code,
      related: marker.relatedInformation?.[0]?.resource.toString(),
    }));
    first.dispose();
    const remaining = monaco.editor
      .getModelMarkers({ resource: model.uri })
      .map((marker) => marker.message);
    const editing = action.edit!.edits[0] as monaco.languages.IWorkspaceTextEdit;
    model.applyEdits([editing.textEdit]);
    inlineProvider.freeInlineCompletions(inline!);
    completion?.dispose?.();
    actionList?.dispose();
    signatures?.dispose();
    hints?.dispose();
    return {
      seen,
      completion: {
        incomplete: completion!.incomplete,
        label: item.label,
        kind: item.kind,
        expectedKind: monaco.languages.CompletionItemKind.Function,
        insertText: item.insertText,
        insertAsSnippet: Boolean(
          item.insertTextRules! & monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        ),
        range: item.range,
        documentation: {
          ...(item.documentation as monaco.IMarkdownString),
          baseUri: (item.documentation as monaco.IMarkdownString).baseUri?.toString(),
        },
        additionalTextEdits: item.additionalTextEdits,
        command: item.command,
        resolvedDetail: resolved!.detail,
      },
      definition: { ...definition[0], uri: definition[0]!.uri.toString() },
      inline: inline!.items[0],
      action: {
        kinds: actionProvider.providedCodeActionKinds,
        kind: action.kind,
        disabled: action.disabled,
        preferred: action.isPreferred,
        resource: editing.resource.toString(),
        command: actionResolved!.command,
        textAfterEdit: model.getValue(),
      },
      signature: {
        triggers: signatureProvider.signatureHelpTriggerCharacters,
        retriggers: signatureProvider.signatureHelpRetriggerCharacters,
        parameters: signatures!.value.signatures[0]!.parameters,
      },
      inlay: {
        label: (hint!.label as monaco.languages.InlayHintLabelPart[]).map((part) => ({
          label: part.label,
          command: part.command,
          location: part.location?.uri.toString(),
        })),
        tooltip: hint!.tooltip,
        paddingLeft: hint!.paddingLeft,
        textEdits: hint!.textEdits,
        released: releasesOnDispose,
      },
      colors,
      markers,
      remaining,
    };
  } finally {
    for (const disposable of disposables.reverse()) disposable.dispose();
    model.dispose();
    token.dispose();
  }
}
