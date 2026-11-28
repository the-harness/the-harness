export interface CommentMenuItem {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}
export interface CommentsContributions {
  commands?: readonly { command: string; title: string | { value: string }; enablement?: string }[];
  menus?: Readonly<Record<string, readonly CommentMenuItem[]>>;
}
export interface CommentData {
  id: number;
  body: string | { value: string };
  author: { name: string; iconPath?: { scheme: string; path: string } };
  mode: number;
  contextValue?: string;
  label?: string;
}
export interface CommentControllerData {
  handle: number;
  id: string;
  label: string;
  options?: { prompt?: string; placeHolder?: string };
  contributions: CommentsContributions;
}
export interface CommentThreadData {
  handle: number;
  controller: number;
  uri: { scheme: string; path: string; authority?: string; query?: string; fragment?: string };
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
  comments: readonly CommentData[];
  collapsibleState: number;
  canReply: boolean | { name: string };
  contextValue?: string;
  label?: string;
  state?: number;
}
