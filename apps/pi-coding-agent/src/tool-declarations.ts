import type { Tool } from "@earendil-works/pi-ai";
import { FunctionToolDeclaration, type ToolDeclaration } from "@harness/llm";

/** pi 的工具模型只有 JSON Schema 参数，只有 function 声明能进去。 */
export function toPiTool(declaration: FunctionToolDeclaration): Tool {
  return {
    name: declaration.name,
    description: declaration.description,
    parameters: declaration.parameters,
  };
}

export function fromPiTool(tool: Tool): ToolDeclaration {
  return FunctionToolDeclaration.create({
    name: tool.name,
    description: tool.description,
    parameters: { ...(tool.parameters as Record<string, unknown>) },
  });
}
