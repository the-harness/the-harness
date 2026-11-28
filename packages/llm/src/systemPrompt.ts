import { extractText, SystemMessage, TextBlock, type Message } from "./message.ts";
import type { LlmRequest } from "./types.ts";

function updateSection(
  sections: Map<string, SystemMessage>,
  sectionId: string,
  message: SystemMessage,
): void {
  if (message.content.length === 0) {
    sections.delete(sectionId);
  } else {
    sections.set(sectionId, message);
  }
}

export function snapshotSystemPrompt(messages: readonly SystemMessage[]): readonly SystemMessage[] {
  const base: SystemMessage[] = [];
  const sections = new Map<string, SystemMessage>();
  for (const message of messages) {
    if (message.sectionId === undefined) {
      base.push(message);
    } else {
      updateSection(sections, message.sectionId, message);
    }
  }
  return [...base, ...sections.values()];
}

export function projectSystemPrompt(request: LlmRequest, inHistory: boolean): LlmRequest {
  const base = [
    request.systemPrompt,
    ...request.messages.flatMap((message) =>
      message instanceof SystemMessage && message.sectionId === undefined
        ? [extractText(message.content)]
        : [],
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
  const sections = new Map<string, SystemMessage>();
  const messages: Message[] = [];
  const render = () =>
    [base, ...Array.from(sections.values(), (section) => extractText(section.content))]
      .filter(Boolean)
      .join("\n\n");
  let leading = base;
  let effective = base;

  for (const message of request.messages) {
    if (!(message instanceof SystemMessage)) {
      messages.push(message);
      continue;
    }

    if (message.sectionId === undefined) continue;
    updateSection(sections, message.sectionId, message);
    if (!inHistory) continue;
    const next = render();
    if (next === effective) continue;
    effective = next;
    if (messages.length === 0) {
      leading = next;
    } else {
      if (messages.at(-1) instanceof SystemMessage) messages.pop();
      messages.push(
        SystemMessage.create({
          id: message.id,
          content: next ? [TextBlock.create({ text: next })] : [],
        }),
      );
    }
  }

  const systemPrompt = inHistory ? leading : render();
  return { ...request, systemPrompt: systemPrompt || undefined, messages };
}
