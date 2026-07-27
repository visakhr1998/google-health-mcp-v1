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

export function registerRollupTools(server: McpServer): void {
  server.registerTool(
    "googlehealth_daily_rollup",
    {
      title: "Daily Roll-Up",
      description:
        "Aggregate health data points over civil-time day intervals. Returns summarised values (e.g. total steps per day) for a date range.\n\n" +
        "Dates use civil time (YYYY-MM-DD) in the user's local timezone. The range is closed-open: start is inclusive, end is exclusive.\n\n" +
        "Example: start_date '2026-06-09', end_date '2026-06-16' returns 7 days (June 9-15).\n\n" +
        "Returns: { rollupDataPoints: [{ civilStartTime, civilEndTime, [dataType]: { ... } }] }\n\n" +
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
          .describe("Number of days per bucket (default 1)"),
        ...paginationSchema,
        response_format: responseFormatSchema,
      },
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ data_type, start_date, end_date, window_size_days, page_size, page_token, response_format }) =>
      safeTool(async () => {
        const data = await makeApiRequest<Record<string, unknown>>(
          `users/me/dataTypes/${data_type}/dataPoints:dailyRollUp`,
          "POST",
          {
            range: {
              start: { date: civilDate(start_date), time: MIDNIGHT },
              end: { date: civilDate(end_date), time: MIDNIGHT },
            },
            windowSizeDays: window_size_days,
            pageSize: page_size,
            ...(page_token ? { pageToken: page_token } : {}),
          }
        );
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
