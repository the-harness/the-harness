import {
  Diagnostic,
  DiagnosticRelatedInformation,
  Location,
  Range,
  Uri,
  type UriComponents,
} from "@harness/vscode-types";

type PositionSnapshot = { line: number; character: number };
type RangeSnapshot = { start: PositionSnapshot; end: PositionSnapshot };

function reviveRange({ start, end }: RangeSnapshot): Range {
  return new Range(start.line, start.character, end.line, end.character);
}
type DiagnosticSnapshot = Pick<Diagnostic, "message" | "severity" | "source" | "tags"> & {
  range: RangeSnapshot;
  code?: string | number | { value: string | number; target: UriComponents };
  relatedInformation?: readonly {
    location: { uri: UriComponents; range: RangeSnapshot };
    message: string;
  }[];
};
export type EditorDiagnosticsSnapshot = readonly [UriComponents, readonly DiagnosticSnapshot[]][];

function reviveDiagnostic(raw: DiagnosticSnapshot): Diagnostic {
  const diagnostic = new Diagnostic(reviveRange(raw.range), raw.message, raw.severity);
  diagnostic.source = raw.source;
  diagnostic.code =
    typeof raw.code === "object"
      ? { value: raw.code.value, target: Uri.from(raw.code.target) }
      : raw.code;
  diagnostic.tags = raw.tags;
  diagnostic.relatedInformation = raw.relatedInformation?.map(
    ({ location, message }) =>
      new DiagnosticRelatedInformation(
        new Location(Uri.from(location.uri), reviveRange(location.range)),
        message,
      ),
  );
  return diagnostic;
}

export function createEditorDiagnostics(onChange: (uris: readonly Uri[]) => void) {
  const entries = new Map<string, [Uri, readonly Diagnostic[]]>();
  return {
    entries,
    accept(snapshot: EditorDiagnosticsSnapshot, replace = false): void {
      const nextResources = new Set<string>();
      const changed = new Map<string, Uri>();
      for (const [rawUri, rawDiagnostics] of snapshot) {
        const uri = Uri.from(rawUri);
        const key = uri.toString();
        nextResources.add(key);
        const diagnostics = rawDiagnostics.map(reviveDiagnostic);
        const previous = entries.get(key)?.[1] ?? [];
        if (JSON.stringify(previous) === JSON.stringify(diagnostics)) continue;

        if (diagnostics.length) entries.set(key, [uri, diagnostics]);
        else entries.delete(key);
        changed.set(key, uri);
      }
      if (replace) {
        for (const [key, [uri]] of entries) {
          if (nextResources.has(key)) continue;
          entries.delete(key);
          changed.set(key, uri);
        }
      }
      if (changed.size) onChange([...changed.values()]);
    },
  };
}
