import type { Uri } from "./uri.ts";

export class TabInputText {
  readonly uri: Uri;
  constructor(uri: Uri) {
    this.uri = uri;
  }
}

export class TabInputTextDiff {
  readonly original: Uri;
  readonly modified: Uri;
  constructor(original: Uri, modified: Uri) {
    this.original = original;
    this.modified = modified;
  }
}

export class TabInputNotebook {
  readonly uri: Uri;
  readonly notebookType: string;
  constructor(uri: Uri, notebookType: string) {
    this.uri = uri;
    this.notebookType = notebookType;
  }
}

export class TabInputNotebookDiff {
  readonly original: Uri;
  readonly modified: Uri;
  readonly notebookType: string;
  constructor(original: Uri, modified: Uri, notebookType: string) {
    this.original = original;
    this.modified = modified;
    this.notebookType = notebookType;
  }
}

export class TabInputCustom {
  readonly uri: Uri;
  readonly viewType: string;
  constructor(uri: Uri, viewType: string) {
    this.uri = uri;
    this.viewType = viewType;
  }
}

export class TabInputWebview {
  readonly viewType: string;
  constructor(viewType: string) {
    this.viewType = viewType;
  }
}

export class TabInputTerminal {}
