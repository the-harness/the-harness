import { URI, Utils } from "vscode-uri";

export type Uri = URI;
export type UriComponents = Parameters<typeof URI.from>[0];
export const Uri = Object.assign(URI, { joinPath: Utils.joinPath });

export class RelativePattern {
  baseUri: Uri;
  pattern: string;

  constructor(base: Uri | { uri: Uri } | string, pattern: string) {
    this.baseUri = typeof base === "string" ? Uri.file(base) : Uri.isUri(base) ? base : base.uri;
    this.pattern = pattern;
  }

  get base(): string {
    return this.baseUri.fsPath;
  }

  set base(value: string) {
    this.baseUri = Uri.file(value);
  }
}
