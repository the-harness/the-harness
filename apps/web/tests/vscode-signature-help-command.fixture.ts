import * as monaco from "monaco-editor";

export function registerNativeSignatureFixture(): void {
  monaco.languages.registerSignatureHelpProvider(
    [
      { language: "plaintext", scheme: "signature-fixture", pattern: "**/native.sig" },
      { language: "plaintext", scheme: "file", pattern: "**/file.sig" },
    ],
    {
      provideSignatureHelp(model, position, _token, context) {
        if (
          model.getValue() !== "call(a," ||
          position.column !== 8 ||
          context.triggerCharacter !== ","
        )
          throw new Error("Unexpected native signature query");
        return {
          value: {
            signatures: [{ label: "native(value)", parameters: [{ label: "value" }] }],
            activeSignature: 0,
            activeParameter: 0,
          },
          dispose() {},
        };
      },
    },
  );
}
