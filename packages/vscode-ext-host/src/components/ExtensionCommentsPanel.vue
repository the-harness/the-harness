<!--
  UI reference skill: vscode-ui
  Reference revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e
  Reference components: Button, InputBox
  Adaptation: Workbench comment threads with existing extension actions and reply input.
  Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License.
-->
<script setup lang="ts">
import { inject } from "@harness/di";
import { MarkdownView } from "@harness/ui-chat";
import { computed, nextTick, reactive, ref, shallowRef, watch } from "vue";
import { ContextMenu } from "@harness/ui-menu";
import { ExtensionHostClientService } from "../client.ts";
import type { CommentThreadState } from "../main-thread/comments.ts";

const extHost = inject(ExtensionHostClientService);
const comments = computed(() => extHost.comments);
const threads = computed(() => [...(comments.value?.threads.values() ?? [])]);
const drafts = reactive(new Map<string, string>());
const errors = reactive(new Map<string, string>());
const sections = new Map<string, HTMLElement>();
function section(key: string, value: unknown) {
  if (value instanceof HTMLElement) sections.set(key, value);
  else sections.delete(key);
}
function title(thread: CommentThreadState) {
  return (
    thread.label ??
    `${decodeURIComponent(thread.uri.path.split("/").at(-1) ?? thread.uri.path)}${thread.range ? `:${thread.range.start.line + 1}` : ""}`
  );
}
async function perform(thread: CommentThreadState, action: () => Promise<void>) {
  try {
    await action();
    errors.delete(thread.key);
  } catch (error) {
    errors.set(thread.key, error instanceof Error ? error.message : String(error));
  }
}
async function reply(thread: CommentThreadState, command: string) {
  await comments.value?.invoke(thread.key, command, undefined, drafts.get(thread.key) ?? "");
  drafts.delete(thread.key);
}
const contextMenu = ref<InstanceType<typeof ContextMenu>>();
const menuTarget = shallowRef<{ owner: typeof extHost.comments; context: { threadKey: string; commentId?: number } }>();
const menuGroups = computed(() => {
  const target = menuTarget.value;
  if (!target || target.owner !== comments.value) return [];
  const thread = comments.value?.threads.get(target.context.threadKey);
  if (!thread) return [];
  const comment = thread.comments.find((item) => item.id === target.context.commentId);
  if (target.context.commentId !== undefined && !comment) return [];
  return extHost.commentMenu.resolve({
    thread, comment,
    actions: comments.value?.actions(thread, comment ? "comments/comment/title" : "comments/commentThread/title", comment?.id) ?? [],
    invoke: (command) => perform(thread, async () => comments.value?.invoke(thread.key, command, comment?.id)),
    reveal: () => perform(thread, async () => comments.value?.reveal(thread.key)),
    toggle: () => perform(thread, async () => comments.value?.toggle(thread.key)),
  });
});

async function openMenu(thread: CommentThreadState, commentId: number | undefined, event: MouseEvent | KeyboardEvent) {
  if (event.defaultPrevented || (event instanceof KeyboardEvent &&
    (event.isComposing || event.keyCode === 229 ||
      (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))))) return;
  const anchor = event.currentTarget;
  if (!(anchor instanceof HTMLElement) || (event.target instanceof HTMLElement && event.target.closest("textarea, input"))) return;
  menuTarget.value = { owner: comments.value, context: { threadKey: thread.key, commentId } };
  event.preventDefault();
  event.stopPropagation();
  await nextTick();
  contextMenu.value?.show(event instanceof MouseEvent ? event : anchor, anchor);
}

watch(
  () =>
    threads.value.reduce<CommentThreadState | undefined>(
      (previous, thread) =>
        thread.focusRevision > (previous?.focusRevision ?? 0) ? thread : previous,
      undefined,
    ),
  async (thread) => {
    if (!thread?.focusRevision) return;
    await nextTick();
    const element = sections.get(thread.key);
    element?.scrollIntoView({ block: "nearest" });
    if (thread.focus === 1) element?.querySelector("textarea")?.focus();
    else if (thread.focus === 2)
      (
        element?.querySelector(
          `[data-comment-id="${thread.focusedComment ?? thread.comments[0]?.id}"]`,
        ) as HTMLElement | null
      )?.focus();
  },
  { immediate: true },
);
</script>

<template>
  <div class="extension-comments">
    <p v-if="!threads.length" class="empty">No comments</p>
    <section
      v-for="thread in threads"
      :key="thread.key"
      :ref="(value) => section(thread.key, value)"
      class="comment-thread"
      tabindex="-1"
      @contextmenu="openMenu(thread, undefined, $event)"
      @keydown="openMenu(thread, undefined, $event)"
      :data-comment-thread="thread.handle"
      @focusin="perform(thread, async () => comments?.activate(thread.key))"
    >
      <div class="thread-heading">
        <button
          type="button"
          class="toggle"
          :aria-expanded="thread.collapsibleState === 1"
          :aria-label="thread.collapsibleState === 1 ? 'Collapse comments' : 'Expand comments'"
          @click="perform(thread, async () => comments?.toggle(thread.key))"
        >
          {{ thread.collapsibleState === 1 ? "▾" : "▸" }}
        </button>
        <button
          type="button"
          class="thread-title"
          @click="perform(thread, async () => comments?.reveal(thread.key))"
        >
          {{ title(thread) }}
        </button>
        <span v-if="thread.state === 1" class="resolved">Resolved</span>
      </div>
      <div v-if="thread.collapsibleState === 1" class="thread-body">
        <div class="actions">
          <button
            v-for="action in comments?.actions(thread, 'comments/commentThread/title')"
            :key="action.command"
            type="button"
            :disabled="!action.enabled"
            @click="perform(thread, async () => comments?.invoke(thread.key, action.command))"
          >
            {{ action.title }}
          </button>
        </div>
        <article
          v-for="comment in thread.comments"
          :key="comment.id"
          :data-comment-id="comment.id"
          @contextmenu="openMenu(thread, comment.id, $event)"
          @keydown="openMenu(thread, comment.id, $event)"
          tabindex="-1"
          @focusin.stop="perform(thread, async () => comments?.activate(thread.key, comment.id))"
        >
          <header>
            <strong>{{ comment.author.name }}</strong
            ><span v-if="comment.label">{{ comment.label }}</span>
          </header>
          <MarkdownView
            :text="typeof comment.body === 'string' ? comment.body : comment.body.value"
          />
          <div class="actions">
            <button
              v-for="action in comments?.actions(thread, 'comments/comment/title', comment.id)"
              :key="action.command"
              type="button"
              :disabled="!action.enabled"
              @click="
                perform(thread, async () =>
                  comments?.invoke(thread.key, action.command, comment.id),
                )
              "
            >
              {{ action.title }}
            </button>
          </div>
        </article>
        <div class="actions">
          <button
            v-for="action in comments?.actions(thread, 'comments/commentThread/additionalActions')"
            :key="action.command"
            type="button"
            :disabled="!action.enabled"
            @click="perform(thread, async () => comments?.invoke(thread.key, action.command))"
          >
            {{ action.title }}
          </button>
        </div>
        <div
          v-if="
            thread.canReply &&
            comments?.controllerFor(thread)?.contributions.menus?.['comments/commentThread/context']
              ?.length
          "
          class="reply"
        >
          <label :for="`reply-${thread.handle}`">{{
            comments?.controllerFor(thread)?.options?.prompt ?? "Reply"
          }}</label>
          <textarea
            :id="`reply-${thread.handle}`"
            :value="drafts.get(thread.key) ?? ''"
            :placeholder="comments?.controllerFor(thread)?.options?.placeHolder ?? 'Write a reply…'"
            @input="drafts.set(thread.key, ($event.target as HTMLTextAreaElement).value)"
          />
          <div class="actions">
            <button
              v-for="action in comments?.actions(
                thread,
                'comments/commentThread/context',
                undefined,
                drafts.get(thread.key),
              )"
              :key="action.command"
              type="button"
              :disabled="!action.enabled || !drafts.get(thread.key)?.trim()"
              @click="perform(thread, () => reply(thread, action.command))"
            >
              {{ action.title }}
            </button>
          </div>
        </div>
      </div>
      <p v-if="errors.has(thread.key)" role="alert">{{ errors.get(thread.key) }}</p>
    </section>
    <ContextMenu ref="contextMenu" label="Comment actions" :groups="menuGroups" />
  </div>
</template>

<style scoped>
.extension-comments {
  font-size: 12px;
  line-height: 1.5;
  color: var(--fg);
  padding: 8px;
}
.empty {
  color: var(--muted);
}
.comment-thread {
  margin-bottom: 12px;
  border: 1px solid var(--control-border);
  border-radius: 4px;
}
.thread-heading {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
}
.thread-title {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
}
.thread-title,
.toggle {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.thread-body {
  padding: 4px 8px 8px;
}
article {
  border-bottom: 1px solid var(--border);
  padding: 6px 0;
}
header {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
header span,
.resolved {
  color: var(--muted);
  font-size: 11px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.actions button {
  box-sizing: border-box;
  display: inline-flex;
  padding: 3px 6px;
  border-radius: 4px;
  cursor: pointer;
  justify-content: center;
  align-items: center;
  border: 1px solid var(--control-border);
  background: var(--hover);
  color: var(--fg);
  line-height: 14px;
  font-size: 11px;
}
.actions button:hover {
  background: var(--selected);
}
.actions button:disabled {
  opacity: 0.4;
  cursor: default;
}
.reply {
  display: grid;
  gap: 6px;
  margin-top: 8px;
}
textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 58px;
  border: 1px solid var(--control-border);
  border-radius: 4px;
  padding: 4px 6px;
  resize: vertical;
  font: inherit;
  background: var(--input);
  color: var(--fg);
}
button:focus-visible,
textarea:focus,
article:focus {
  outline: 1px solid var(--selection-border);
  outline-offset: 1px;
}
[role="alert"] {
  color: var(--red);
  padding: 0 8px;
}
</style>
