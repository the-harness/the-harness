import * as monaco from "monaco-editor";

let nativeListsReleased = 0;

export function registerNativeLinkFixture() {
  monaco.languages.registerLinkProvider(
    { language: "plaintext", scheme: "file", pattern: "**/sample.link-fixture" },
    {
      provideLinks() {
        return {
          links: [
            {
              range: new monaco.Range(2, 10, 2, 15),
              url: "https://example.test/native",
              tooltip: "Native provider",
            },
          ],
          dispose() {
            nativeListsReleased++;
          },
        };
      },
    },
  );
}

export function releasedNativeLinkLists() {
  return nativeListsReleased;
}
