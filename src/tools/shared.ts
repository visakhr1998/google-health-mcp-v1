import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeApiRequest, handleApiError } from "../api-client.js";
import { DATA_TYPES, CHARACTER_LIMIT } from "../constants.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Every tool here reads; none mutate Google Health state. `openWorldHint`
 * stays true because responses depend on a remote service.
 */
export const READONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Caps a response so a wide date range cannot blow the model's context. */
export function truncateIfNeeded(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    "\n\n--- Response truncated. Use pagination or narrower filters to see more. ---"
  );
}

/** Converts a throw into an error result rather than killing the tool call. */
export async function safeTool(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
  }
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text: truncateIfNeeded(text) }] };
}

export function jsonResult(data: unknown): ToolResult {
  return textResult(JSON.stringify(data, null, 2));
}

export const dataTypeEnum = z.enum(DATA_TYPES);

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export const responseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.JSON)
  .describe("Output format: 'json' for structured data or 'markdown' for human-readable");

export const paginationSchema = {
  page_size: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe("Results per page (1-100, default 25)"),
  page_token: z.string().optional().describe("Token for retrieving the next page of results"),
};

/** Shared tail of every dual-format tool: pick a rendering, then truncate. */
export function respond<T>(
  data: T,
  format: ResponseFormat,
  toMarkdown: (data: T) => string
): ToolResult {
  return textResult(
    format === ResponseFormat.MARKDOWN ? toMarkdown(data) : JSON.stringify(data, null, 2)
  );
}

/** Registers a no-input GET tool. These differ only by name, text, and path. */
export function registerSimpleTool(
  server: McpServer,
  options: { name: string; title: string; description: string; path: string }
): void {
  server.registerTool(
    options.name,
    {
      title: options.title,
      description: options.description,
      inputSchema: {},
      annotations: READONLY_ANNOTATIONS,
    },
    async () => safeTool(async () => jsonResult(await makeApiRequest(options.path)))
  );
}
