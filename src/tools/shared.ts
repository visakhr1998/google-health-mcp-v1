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

/**
 * Caps prose output. Only safe for markdown, where a trailing notice is just
 * more prose — never for JSON, which this would leave unparseable. See
 * `fitJson` for the structured equivalent.
 */
export function truncateIfNeeded(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    "\n\n--- Response truncated. Use pagination or narrower filters to see more. ---"
  );
}

/** Payload fields that hold the record array, in the order we look for them. */
const RECORD_FIELDS = ["dataPoints", "rollupDataPoints"] as const;

export type FitResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; message: string };

function renderWithRecords(
  payload: Record<string, unknown>,
  field: string,
  records: readonly unknown[],
  keep: number
): string {
  return JSON.stringify(
    {
      ...payload,
      [field]: records.slice(0, keep),
      truncated: true,
      truncationInfo: {
        returnedRecords: keep,
        omittedRecords: records.length - keep,
        characterLimit: CHARACTER_LIMIT,
        reason: "Response exceeded the character limit. Use page_token or a narrower filter.",
      },
    },
    null,
    2
  );
}

/**
 * Render a payload as JSON that always parses.
 *
 * Slicing a JSON string at a character limit produces a document that is
 * neither valid JSON nor a structured error, and a client that treats an
 * unparseable body as "no records" silently loses data. So instead of cutting
 * mid-document, drop whole records until the result fits and say so in-band
 * via `truncated` and `truncationInfo`.
 *
 * If not even one record fits, there is no valid subset to return — that is
 * reported as an error rather than as an empty success.
 */
export function fitJson(data: unknown): FitResult {
  const full = JSON.stringify(data, null, 2);
  if (full.length <= CHARACTER_LIMIT) return { ok: true, text: full, truncated: false };

  if (data && typeof data === "object" && !Array.isArray(data)) {
    const payload = data as Record<string, unknown>;
    const field = RECORD_FIELDS.find((f) => Array.isArray(payload[f]));
    if (field) {
      const records = payload[field] as unknown[];
      // Largest prefix of records that still fits, by binary search.
      let low = 0;
      let high = records.length;
      let best = 0;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (renderWithRecords(payload, field, records, mid).length <= CHARACTER_LIMIT) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (best > 0) {
        return { ok: true, text: renderWithRecords(payload, field, records, best), truncated: true };
      }
    }
  }

  return {
    ok: false,
    message:
      `Error: RESPONSE_TOO_LARGE. The response exceeds the ${CHARACTER_LIMIT}-character ` +
      "limit and no valid subset could be returned. Narrow the query with a filter, a " +
      "smaller date range, or a smaller page_size.",
  };
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
  const fit = fitJson(data);
  if (!fit.ok) return { content: [{ type: "text", text: fit.message }], isError: true };
  return { content: [{ type: "text", text: fit.text }] };
}

/**
 * Follow `nextPageToken` past empty pages.
 *
 * Upstream paging over sparse date ranges can return a page with no records
 * that still carries a token, with data on later pages. "Empty means done" is
 * the obvious client implementation and it silently truncates the walk, so the
 * skipping happens here instead. Bounded, so a pathological range cannot spin.
 */
export async function fetchNonEmptyPage<T extends Record<string, unknown>>(
  fetchPage: (pageToken?: string) => Promise<T>,
  recordField: string,
  startToken?: string,
  maxHops = 50
): Promise<T> {
  let page = await fetchPage(startToken);
  let hops = 0;

  while (hops < maxHops) {
    const records = page[recordField];
    const isEmpty = Array.isArray(records) && records.length === 0;
    const token = typeof page.nextPageToken === "string" ? page.nextPageToken : "";
    if (!isEmpty || !token) break;
    hops++;
    page = await fetchPage(token);
  }

  // Skipping is best-effort: a long enough run of empty pages exhausts the hop
  // budget and an empty page still surfaces. `hasMore` gives clients a signal
  // that does not depend on emptiness, so correct pagination never rests on
  // "empty means done".
  return { ...page, hasMore: Boolean(page.nextPageToken) };
}

/**
 * Search-strategy guidance appended to discovery-oriented tool descriptions.
 * Steers callers away from narrow-then-widen date-range guessing (7 days,
 * then 14, then 30, ...) — each retry is a wasted call where one generous
 * window would have answered the question outright. One constant reused
 * everywhere so the rule can't drift out of sync between tools.
 */
export const WIDE_WINDOW_GUIDANCE =
  "\n\nSearch strategy: if the user hasn't given you a specific date range, default to " +
  "a wide window (90+ days) rather than starting narrow and re-querying wider each time " +
  "the result comes back empty. Narrow the window only when the user specified one.";

/**
 * Appended to every tool description whose response can come back marked
 * `truncated:true`. Without this, a caller that hits truncation has no
 * signal that it must not treat the response as exhaustive — which is
 * exactly what happened live: a truncated response was summarized as "no
 * other runs since X" when records matching the question had in fact been
 * left out. `truncated:true` means incomplete, not "safe to summarize as if
 * complete." One constant reused everywhere so the rule can't drift.
 */
export const TRUNCATION_CAUTION =
  "\n\nIf the response comes back with truncated:true, treat it as incomplete — do not " +
  'state a completeness conclusion (e.g. "no other X", "that\'s the most recent one") ' +
  "from it. Some matching records were left out and you do not know which. Follow " +
  "truncationInfo's advice (page further or narrow the query) before answering, or say " +
  "explicitly that the answer is based on partial data.";

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
  // Markdown is prose, so a trailing truncation notice is harmless. JSON goes
  // through fitJson, which drops whole records rather than cutting the document.
  return format === ResponseFormat.MARKDOWN ? textResult(toMarkdown(data)) : jsonResult(data);
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
