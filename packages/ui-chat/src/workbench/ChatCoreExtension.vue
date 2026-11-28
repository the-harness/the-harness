<script setup lang="ts">
import { useService } from "@harness/ui-di";
import { UiNotificationService } from "@harness/ui-notifications";
import {
  BashTool,
  EditTool,
  FindTool,
  GrepTool,
  LsTool,
  ReadTool,
  ToolCallView,
  WriteTool,
} from "@harness/pi-tools/ui";
import { UiWorkbenchService } from "@harness/ui-workbench";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { ChatBlockSlot, ChatTurnFooterSlot } from "../panels/ChatPanel.vue";
import MarkdownCodeBlock from "../components/MarkdownCodeBlock.vue";
import MarkdownView from "../components/MarkdownView.vue";
import ThinkingBlock from "../components/ThinkingBlock.vue";
import TurnFilesSummary from "../components/TurnFilesSummary.vue";

const workbench = useService(UiWorkbenchService);
const workspace = useService(UiWorkspaceService);
const notifications = useService(UiNotificationService);

function langFromPath(path = "") {
  if (path.endsWith(".vue")) return "vue";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".ts") || path.endsWith(".js")) return "ts";
  if (path.endsWith(".py")) return "py";
  if (path.endsWith(".rs")) return "rs";
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".sh")) return "bash";
  return "";
}

function baseName(path = "") {
  return path.split("/").at(-1) || path;
}

function dirName(path = "") {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "";
}

function openFile(path?: string) {
  if (!path) return;
  const found = workspace.files.find((item) => item.path === path || item.path.endsWith(path));
  if (found) workspace.selectFile(found);
  workbench.open("preview");
}

async function copyText(text?: string) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    notifications.notify("Copied to clipboard");
  } catch {
    notifications.notify("Clipboard is not available in this browser");
  }
}
</script>

<template>
  <!-- Text Block Contribution -->
  <ChatBlockSlot.Contribute v-slot="{ block, Next }">
    <div v-if="block.kind === 'text'" class="a-prose">
      <MarkdownView :text="block.text" :streaming="block.streaming" />
    </div>
    <component :is="Next" v-else />
  </ChatBlockSlot.Contribute>

  <!-- Thinking Block Contribution -->
  <ChatBlockSlot.Contribute v-slot="{ block, Next }">
    <ThinkingBlock
      v-if="block.kind === 'thinking'"
      :text="block.text"
      :duration="block.duration"
      :streaming="block.streaming"
    />
    <component :is="Next" v-else />
  </ChatBlockSlot.Contribute>

  <!-- Pi Tools Block Contributions -->
  <ChatBlockSlot.Contribute v-slot="{ block, Next }">
    <ReadTool
      v-if="block.kind === 'tool' && block.tool.name === 'read'"
      :tool="block.tool"
      :code-block="MarkdownCodeBlock"
      @open-file="openFile"
      @copy="copyText"
    />
    <EditTool
      v-else-if="block.kind === 'tool' && block.tool.name === 'edit'"
      :tool="block.tool"
      :code-block="MarkdownCodeBlock"
      @open-file="openFile"
      @copy="copyText"
    />
    <WriteTool
      v-else-if="block.kind === 'tool' && block.tool.name === 'write'"
      :tool="block.tool"
      :code-block="MarkdownCodeBlock"
      @open-file="openFile"
      @copy="copyText"
    />
    <BashTool
      v-else-if="block.kind === 'tool' && block.tool.name === 'bash'"
      :tool="block.tool"
      :code-block="MarkdownCodeBlock"
      @copy="copyText"
    />
    <GrepTool
      v-else-if="block.kind === 'tool' && block.tool.name === 'grep'"
      :tool="block.tool"
      @copy="copyText"
    />
    <FindTool
      v-else-if="block.kind === 'tool' && block.tool.name === 'find'"
      :tool="block.tool"
      @copy="copyText"
    />
    <LsTool
      v-else-if="block.kind === 'tool' && block.tool.name === 'ls'"
      :tool="block.tool"
      @copy="copyText"
    />
    <ToolCallView v-else-if="block.kind === 'tool'" :tool="block.tool" @copy="copyText" />
    <component :is="Next" v-else />
  </ChatBlockSlot.Contribute>

  <!-- Turn Footer File Changes Summary Contribution -->
  <ChatTurnFooterSlot.Contribute v-slot="{ message, Next }">
    <component :is="Next" />
    <TurnFilesSummary v-if="message.changes?.length" :changes="message.changes" />
  </ChatTurnFooterSlot.Contribute>
</template>
