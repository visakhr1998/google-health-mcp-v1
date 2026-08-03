import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeApiRequest } from "../api-client.js";
import { formatRollUp } from "../formatters.js";
import {
  READONLY_ANNOTATIONS,
  ResponseFormat,
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
 * The dailyRollUp endpoint rejects a range longer than the requested page size,
 * and rejects any page size above 90. Verified by bisection against the live
 * API: days=60/pageSize=60 succeeds, days=61/pageSize=60 fails; pageSize 90
 * succeeds, 91 fails.
 *
 * Range and page size are independent concerns, so rather than exposing that
 * coupling the server splits long ranges into windows and pages each one.
 */
const MAX_ROLLUP_PAGE_SIZE = 90;

const toUtc = (date: string): number => Date.parse(`${date}T00:00:00Z`);
const fromUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

/**
 * Largest chunk that satisfies the API limit while staying a whole number of
 * buckets — a chunk that is not a multiple of the bucket width would split a
 * bucket across two requests and report it twice, half-filled.
 */
function chunkDays(windowSizeDays: number): number {
  const whole = Math.floor(MAX_ROLLUP_PAGE_SIZE / windowSizeDays) * windowSizeDays;
  return Math.max(whole, windowSizeDays);
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
          pageSize: MAX_ROLLUP_PAGE_SIZE,
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
        "Required scope: depends on data type category.",
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
            "Days per bucket (default 1). KNOWN LIMITATION: the upstream API rejects any value above 1 with 'Invalid argument', so only 1 currently works."
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
        "Returns: { rollupDataPoints: [{ startTime, endTime, [dataType]: { ... } }] }\n\n" +
        "Required scope: depends on data type category.",
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
