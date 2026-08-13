import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeApiRequest } from "../api-client.js";
import { formatRollUp } from "../formatters.js";
import {
  READONLY_ANNOTATIONS,
  ResponseFormat,
  TRUNCATION_CAUTION,
  WIDE_WINDOW_GUIDANCE,
  dataTypeEnum,
  paginationSchema,
  respond,
  responseFormatSchema,
  safeTool,
} from "./shared.js";

const dateSchema = (example: string, note: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .describe(`${note} (e.g. '${example}')`);

/** Splits YYYY-MM-DD into the civil-date object the dailyRollUp endpoint wants. */
function civilDate(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

const MIDNIGHT = { hours: 0, minutes: 0, seconds: 0 };

/**
 * The dailyRollUp endpoint enforces two rules, confirmed against the live API
 * across 19 combinations of range, window size and page size:
 *
 *   1. pageSize * windowSizeDays <= 90   — one page may span at most 90 days
 *   2. rangeDays <= pageSize * windowSizeDays — the range must fit in one page
 *
 * In other words the endpoint does not paginate a range at all: the whole
 * request has to fit inside a single page, and a page covers at most 90 days.
 * At windowSizeDays=1 that collapses to the more obvious-looking
 * "rangeDays <= pageSize <= 90", which is what makes the real rule easy to
 * mis-infer — and sending a fixed pageSize of 90 then asks for a 630-day page
 * at windowSizeDays=7, which is rejected.
 *
 * So the page size is derived per chunk from the bucket count rather than
 * fixed, and callers never see any of this.
 */
const MAX_PAGE_SPAN_DAYS = 90;

const toUtc = (date: string): number => Date.parse(`${date}T00:00:00Z`);
const fromUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

/**
 * Largest chunk that satisfies the 90-day page span while staying a whole
 * number of buckets — a chunk that is not a multiple of the bucket width would
 * split a bucket across two requests and report it twice, half-filled.
 */
function chunkDays(windowSizeDays: number): number {
  const whole = Math.floor(MAX_PAGE_SPAN_DAYS / windowSizeDays) * windowSizeDays;
  return Math.max(whole, windowSizeDays);
}

/**
 * Page size for one chunk: exactly the number of buckets it contains.
 *
 * Satisfies both rules by construction — `buckets * window >= days` because of
 * the rounding up, and `buckets * window <= 90` because `days` never exceeds
 * `chunkDays(window)`, which is itself capped at 90.
 */
function pageSizeForChunk(days: number, windowSizeDays: number): number {
  return Math.max(1, Math.ceil(days / windowSizeDays));
}

/** Fetches every bucket in a range, chunking and paging as needed. */
async function fetchAllBuckets(
  dataType: string,
  startDate: string,
  endDate: string,
  windowSizeDays: number
): Promise<unknown[]> {
  const endMs = toUtc(endDate);
  const step = chunkDays(windowSizeDays) * DAY_MS;
  const buckets: unknown[] = [];

  for (let cursor = toUtc(startDate); cursor < endMs; cursor += step) {
    const chunkEnd = Math.min(cursor + step, endMs);
    const chunkSpanDays = Math.round((chunkEnd - cursor) / DAY_MS);
    let pageToken: string | undefined;

    do {
      const data = await makeApiRequest<Record<string, unknown>>(
        `users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`,
        "POST",
        {
          range: {
            start: { date: civilDate(fromUtc(cursor)), time: MIDNIGHT },
            end: { date: civilDate(fromUtc(chunkEnd)), time: MIDNIGHT },
          },
          windowSizeDays,
          pageSize: pageSizeForChunk(chunkSpanDays, windowSizeDays),
          ...(pageToken ? { pageToken } : {}),
        }
      );
      const page = Array.isArray(data.rollupDataPoints) ? data.rollupDataPoints : [];
      buckets.push(...page);
      // An empty page can still carry a token, so the token alone ends the walk.
      pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
    } while (pageToken);
  }

  return buckets;
}

export function registerRollupTools(server: McpServer): void {
  server.registerTool(
    "googlehealth_daily_rollup",
    {
      title: "Daily Roll-Up",
      description:
        "Aggregate health data points over civil-time day intervals. Returns summarised values (e.g. total steps per day) for a date range.\n\n" +
        "Dates use civil time (YYYY-MM-DD) in the user's local timezone. The range is closed-open: start is inclusive, end is exclusive.\n\n" +
        "Example: start_date '2026-06-09', end_date '2026-06-16' returns 7 days (June 9-15).\n\n" +
        "Any range length is accepted. The server splits long ranges into windows and pages through them, returning every bucket in one response, so no client-side chunking is needed.\n\n" +
        "Returns: { rollupDataPoints: [{ civilStartTime, civilEndTime, [dataType]: { ... } }] }\n" +
        "If the result is too large it is trimmed to whole records and marked with truncated:true plus truncationInfo — the JSON always parses.\n\n" +
        "Required scope: depends on data type category." +
        WIDE_WINDOW_GUIDANCE +
        " A wide range is cheap here — the server auto-chunks and pages internally and " +
        "returns every bucket in one response, so there is no need to page manually or " +
        "start narrow. Use max_buckets only if you want to cap the response size." +
        TRUNCATION_CAUTION,
      inputSchema: {
        data_type: dataTypeEnum.describe("The health data type (kebab-case)"),
        start_date: dateSchema("2026-06-09", "Start date inclusive"),
        end_date: dateSchema("2026-06-16", "End date exclusive, e.g. '2026-06-16' to include June 15"),
        window_size_days: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe(
            "Days per bucket (default 1). Use 7 for weekly totals, 30 for monthly. Any value works over any range; the server sizes its upstream requests to match."
          ),
        max_buckets: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Optional cap on how many buckets to return. Omit to get the whole range."),
        response_format: responseFormatSchema,
      },
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ data_type, start_date, end_date, window_size_days, max_buckets, response_format }) =>
      safeTool(async () => {
        if (Date.parse(`${end_date}T00:00:00Z`) <= Date.parse(`${start_date}T00:00:00Z`)) {
          throw new Error(
            `end_date (${end_date}) must be after start_date (${start_date}); the range is closed-open.`
          );
        }

        const all = await fetchAllBuckets(data_type, start_date, end_date, window_size_days);
        const capped = max_buckets ? all.slice(0, max_buckets) : all;
        const data: Record<string, unknown> = {
          rollupDataPoints: capped,
          ...(capped.length < all.length
            ? { truncated: true, truncationInfo: { returnedRecords: capped.length, omittedRecords: all.length - capped.length, reason: "max_buckets" } }
            : {}),
        };

        return respond(data, response_format as ResponseFormat, (d) =>
          formatRollUp(d, data_type, `Daily ${start_date} to ${end_date}`)
        );
      })
  );

  server.registerTool(
    "googlehealth_rollup",
    {
      title: "Roll-Up (Physical Time)",
      description:
        "Aggregate health data points over physical-time windows (e.g. hourly buckets). " +
        "Returns bucketed summaries between two timestamps.\n\n" +
        "Returns: { rollupDataPoints: [{ startTime, endTime, [dataType]: { ... } }] }\n" +
        "If the result is too large it is trimmed to whole buckets and marked truncated:true " +
        "with truncationInfo; the JSON always parses.\n\n" +
        "Required scope: depends on data type category." +
        WIDE_WINDOW_GUIDANCE +
        " When pulling a wide range, also raise page_size toward its max (100) rather " +
        "than paging through it in small steps." +
        TRUNCATION_CAUTION,
      inputSchema: {
        data_type: dataTypeEnum.describe("The health data type (kebab-case)"),
        start_time: z.string().describe("Start timestamp in RFC 3339 format (e.g. 2026-06-01T00:00:00Z)"),
        end_time: z.string().describe("End timestamp in RFC 3339 format"),
        window_size: z
          .string()
          .describe("Aggregation window as duration (e.g. '30s', '3600s' for 1 hour, '86400s' for 1 day)"),
        ...paginationSchema,
        response_format: responseFormatSchema,
      },
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ data_type, start_time, end_time, window_size, page_size, page_token, response_format }) =>
      safeTool(async () => {
        const data = await makeApiRequest<Record<string, unknown>>(
          `users/me/dataTypes/${data_type}/dataPoints:rollUp`,
          "POST",
          {
            range: { startTime: start_time, endTime: end_time },
            windowSize: window_size,
            pageSize: page_size,
            ...(page_token ? { pageToken: page_token } : {}),
          }
        );
        return respond(data, response_format as ResponseFormat, (d) =>
          formatRollUp(d, data_type, `${start_time} to ${end_time} (window: ${window_size})`)
        );
      })
  );
}
