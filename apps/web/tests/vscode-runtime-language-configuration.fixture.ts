import * as monaco from "monaco-editor";
import { StandaloneServices } from "monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js";
import { ILanguageConfigurationService } from "monaco-editor/esm/vs/editor/common/languages/languageConfigurationRegistry.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { effectScope, onScopeDispose, shallowRef } from "vue";
import {
  VscodeLanguagesCompatService,
  VscodeWorkspaceCompatService,
} from "@harness/vscode-editor-compat";
import { runInInjectionContext } from "../../../packages/di/src/instantiation.ts";
import { ForegroundRegistrations } from "../../../packages/vscode-ext-host/src/foreground.ts";
import { createMainThreadLanguages } from "../../../packages/vscode-ext-host/src/main-thread/languages.ts";

const language = "runtime-config-fixture";
const text = "alpha-beta";
const uri = { scheme: "file", path: "/fixture/rules.test" };
let dispose: (() => void) | undefined;
let dispatch: ReturnType<typeof createMainThreadLanguages> | undefined;
let registrations: ForegroundRegistrations | undefined;
let observe: (() => Promise<unknown>) | undefined;
let refreshBase: (() => void) | undefined;

export function openLanguageConfigurationFixture() {
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment ??= {
    getWorker: () => new EditorWorker(),
  };
  const scope = effectScope();
  monaco.languages.register({ id: language });
  let base = monaco.languages.setLanguageConfiguration(language, {
    comments: { lineComment: "//" },
  });
  refreshBase = () => {
    base.dispose();
    base = monaco.languages.setLanguageConfiguration(language, { comments: { lineComment: "//" } });
  };
  const model = monaco.editor.createModel(text, language, monaco.Uri.from(uri));
  const container = document.createElement("div");
  container.style.cssText = "height:160px;width:480px";
  document.body.appendChild(container);
  const editor = monaco.editor.create(container, { model });
  const service = scope.run(() =>
    runInInjectionContext(
      {
        get<T>(id: abstract new (...args: never[]) => T): T {
          if (id === VscodeWorkspaceCompatService) return { textDocuments: shallowRef([]) } as T;
          throw new Error(`Unexpected configuration fixture service: ${id.name}`);
        },
      },
      () => new VscodeLanguagesCompatService(),
    ),
  )!;
  const foreground = new ForegroundRegistrations((error) => {
    throw error;
  });
  foreground.setVisible(true);
  const handler = createMainThreadLanguages(
    service,
    async () => {
      throw new Error("Unexpected provider invocation");
    },
    (register) => foreground.use(() => onScopeDispose(register())),
  );
  dispatch = handler;
  registrations = foreground;
  observe = async () => {
    model.setValue(text);
    const word = model.getWordAtPosition({ lineNumber: 1, column: 3 })?.word;
    editor.setPosition({ lineNumber: 1, column: 1 });
    await editor.getAction("editor.action.commentLine")!.run();
    const configured = StandaloneServices.get(
      ILanguageConfigurationService,
    ).getLanguageConfiguration(language).underlyingConfig as monaco.languages.LanguageConfiguration;
    return {
      word,
      line: model.getValue(),
      enter: configured.onEnterRules?.[0]?.beforeText.flags,
      indentation: configured.indentationRules?.increaseIndentPattern.test("BEGIN"),
      notIn: configured.autoClosingPairs?.[0]?.notIn,
      legacyComment: configured.__electricCharacterSupport?.docComment?.open,
    };
  };
  dispose = () => {
    handler.dispose();
    base.dispose();
    editor.dispose();
    model.dispose();
    container.remove();
    scope.stop();
  };
  return { uri, text, languageId: language, version: 1, isDirty: false, eol: 1 };
}

export function dispatchLanguageConfiguration(id: string, method: string, args: unknown[]) {
  return dispatch?.(id, method, args);
}

export function observeLanguageConfiguration() {
  return observe?.();
}

export function setLanguageConfigurationForeground(visible: boolean) {
  registrations?.setVisible(visible);
}

export function refreshBaseLanguageConfiguration() {
  refreshBase?.();
}

export function closeLanguageConfigurationFixture() {
  dispose?.();
}
