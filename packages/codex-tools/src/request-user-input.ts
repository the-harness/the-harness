import { inject } from "@harness/di";
import {
  SessionInteractionService,
  UserInputInteraction,
  type UserInputResponse,
} from "@harness/user-interaction/node";
import { defineTool } from "@harness/tool-call";
import { z } from "zod";

const optionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});

const questionSchema = z.object({
  id: z.string(),
  header: z.string().optional(),
  question: z.string(),
  isOther: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  options: z.array(optionSchema).optional(),
});

export interface RequestUserInputOptions {
  readonly mode?: "default" | "plan";
  readonly defaultModeRequestUserInput?: boolean;
  readonly interactive?: boolean;
  readonly isSubagent?: boolean;
}

export function shouldEnableRequestUserInput(
  options: RequestUserInputOptions = {},
): boolean {
  if (options.interactive === false || options.isSubagent) return false;
  return options.mode === "plan" || options.defaultModeRequestUserInput === true;
}

export function createRequestUserInputTool() {
  const interaction = inject(SessionInteractionService);

  return defineTool({
    name: "request_user_input",
    description:
      "Request user input for one to three short questions and wait for the response.",
    parameters: z.object({
      questions: z.array(questionSchema).min(1).max(3),
    }),
    async execute(args, ctx) {
      const result = await interaction.request<UserInputResponse>(
        UserInputInteraction.create({
          callId: ctx.callId,
          questions: args.questions.map((q) => ({
            id: q.id,
            header: q.header,
            question: q.question,
            multiSelect: false,
            allowCustom: q.isOther ?? true,
            secret: q.isSecret ?? false,
            options: q.options,
          })),
        }),
        { signal: ctx.signal },
      );

      if (result.status === "cancelled") {
        return JSON.stringify({ answers: {} });
      }

      const answers: Record<string, { answers: string[] }> = {};
      for (const item of result.data.answers) {
        const values = [...item.selected];
        if (item.custom) values.push(item.custom);
        answers[item.id] = { answers: values };
      }
      return JSON.stringify({ answers });
    },
  });
}

export function createRequestUserInputAsyncTool() {
  const interaction = inject(SessionInteractionService);

  return defineTool({
    name: "request_user_input_async",
    description:
      "Request user input asynchronously without blocking the current turn.",
    parameters: z.object({
      questions: z.array(questionSchema).min(1).max(3),
    }),
    async execute(args, ctx) {
      void interaction.request<UserInputResponse>(
        UserInputInteraction.create({
          callId: ctx.callId,
          questions: args.questions.map((q) => ({
            id: q.id,
            header: q.header,
            question: q.question,
            multiSelect: false,
            allowCustom: q.isOther ?? true,
            secret: q.isSecret ?? false,
            options: q.options,
          })),
        }),
        { signal: ctx.signal },
      );

      return JSON.stringify({
        status: "pending",
        callId: ctx.callId,
      });
    },
  });
}
