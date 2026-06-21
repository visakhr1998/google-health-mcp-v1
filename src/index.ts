#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { makeApiRequest, handleApiError, setAccessToken } from "./api-client.js";
import { DATA_TYPES, CHARACTER_LIMIT } from "./constants.js";

const server = new McpServer({
  name: "google-health-mcp-server",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateIfNeeded(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    "\n\n--- Response truncated. Use pagination or narrower filters to see more. ---"
  );
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

async function safeTool(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
  }
}

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(data, null, 2)) }] };
}

function formatCivilDate(civil: Record<string, unknown>): string {
  const d = civil.date as Record<string, number> | undefined;
  if (!d) return JSON.stringify(civil);
  const y = d.year, m = String(d.month).padStart(2, "0"), day = String(d.day).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const dataTypeEnum = z.enum(DATA_TYPES);

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

const responseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.JSON)
  .describe("Output format: 'json' for structured data or 'markdown' for human-readable");

const paginationSchema = {
  page_size: z.number().int().min(1).max(100).default(25).describe("Results per page (1-100, default 25)"),
  page_token: z.string().optional().describe("Token for retrieving the next page of results"),
};

// ---------------------------------------------------------------------------
// Tool: set access token at runtime
// ---------------------------------------------------------------------------

server.registerTool(
  "googlehealth_set_token",
  {
    title: "Set Access Token",
    description:
      "Set or update the Google OAuth 2.0 access token used for all subsequent API calls. " +
      "Obtain a token via the OAuth 2.0 Playground (https://developers.google.com/oauthplayground) " +
      "with the appropriate https://www.googleapis.com/auth/googlehealth.* scopes.",
    inputSchema: {
      access_token: z.string().min(1).describe("Google OAuth 2.0 access token"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ access_token }) => {
    setAccessToken(access_token);
    return { content: [{ type: "text", text: "Access token updated successfully." }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: get user profile
// ---------------------------------------------------------------------------

server.registerTool(
  "googlehealth_get_profile",
  {
    title: "Get User Profile",
    description:
      "Returns the authenticated user's Google Health profile details including name, date of birth, gender, height, weight, and timezone.\n\n" +
      "Returns JSON with fields: displayName, dateOfBirth, gender, height, weight, timezone.\n\n" +
      "Required scope: googlehealth.profile.readonly",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => safeTool(async () => jsonResult(await makeApiRequest("users/me/profile")))
);

// ---------------------------------------------------------------------------
// Tool: get user settings
// ---------------------------------------------------------------------------

server.registerTool(
  "googlehealth_get_settings",
  {
    title: "Get User Settings",
    description:
      "Returns the authenticated user's Google Health settings such as locale, units of measurement, and notification preferences.\n\n" +
      "Required scope: googlehealth.settings.readonly",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => safeTool(async () => jsonResult(await makeApiRequest("users/me/settings")))
);

// ---------------------------------------------------------------------------
// Tool: get user identity
// ---------------------------------------------------------------------------

server.registerTool(
  "googlehealth_get_identity",
  {
    title: "Get User Identity",
    description:
      "Returns the authenticated user's identity information including Fitbit and Google user IDs.\n\n" +
      "Required scope: googlehealth.profile.readonly",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => safeTool(async () => jsonResult(await makeApiRequest("users/me/identity")))
);

// ---------------------------------------------------------------------------
// Tool: list data points
// ---------------------------------------------------------------------------

function formatDataPointsMarkdown(data: Record<string, unknown>, dataType: string): string {
  const points = Array.isArray(data.dataPoints) ? data.dataPoints : [];
  const lines: string[] = [`# ${dataType} Data Points`, "", `Found ${points.length} data point(s).`, ""];
  for (const pt of points) {
    const p = pt as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name.split("/").pop() : "unknown";
    lines.push(`## ${name}`);
    if (p.interval && typeof p.interval === "object") {
      const interval = p.interval as Record<string, unknown>;
      if (interval.startTime) lines.push(`- **Start**: ${interval.startTime}`);
      if (interval.endTime) lines.push(`- **End**: ${interval.endTime}`);
    }
    const skip = new Set(["name", "interval"]);
    for (const [k, v] of Object.entries(p)) {
      if (!skip.has(k) && v !== undefined) {
        lines.push(`- **${k}**: ${typeof v === "object" ? JSON.stringify(v) : v}`);
      }
    }
    lines.push("");
  }
  if (data.nextPageToken) lines.push(`*More results available — use page_token: "${data.nextPageToken}"*`);
  return lines.join("\n");
}

server.registerTool(
  "googlehealth_list_data_points",
  {
    title: "List Health Data Points",
    description:
      "Query health and fitness data points for a specific data type. Supports filtering by time range and pagination.\n\n" +
      "Supported data types include: steps, heart-rate, sleep, exercise, weight, body-fat, blood-glucose, " +
      "active-minutes, distance, floors, total-calories, nutrition-log, and many more.\n\n" +
      "Time filtering examples:\n" +
      '  - filter: \'data_type.interval.start_time >= "2025-01-01T00:00:00Z"\'\n' +
      '  - filter: \'data_type.interval.start_time >= "2025-01-01T00:00:00Z" AND data_type.interval.end_time <= "2025-01-31T23:59:59Z"\'\n\n' +
      "Note: use kebab-case for data_type param but snake_case for data type names inside filter expressions.\n\n" +
      "Returns: { dataPoints: [...], nextPageToken? }\n\n" +
      "Required scope: depends on data type category (activity_and_fitness, health_metrics_and_measurements, sleep, nutrition).",
    inputSchema: {
      data_type: dataTypeEnum.describe("The health data type to query (kebab-case, e.g. 'steps', 'heart-rate', 'sleep')"),
      filter: z.string().optional().describe(
        "Filter expression for time range. Use snake_case for data type names in filters. " +
        'Example: \'data_type.interval.start_time >= "2025-06-01T00:00:00Z"\''
      ),
      ...paginationSchema,
      response_format: responseFormatSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ data_type, filter, page_size, page_token, response_format }) => safeTool(async () => {
    const data = await makeApiRequest<Record<string, unknown>>(
      `users/me/dataTypes/${data_type}/dataPoints`, "GET", undefined,
      { filter, pageSize: page_size, pageToken: page_token }
    );
    const text = response_format === ResponseFormat.MARKDOWN
      ? formatDataPointsMarkdown(data, data_type)
      : JSON.stringify(data, null, 2);
    return { content: [{ type: "text", text: truncateIfNeeded(text) }] };
  })
);

// ---------------------------------------------------------------------------
// Tool: get single data point
// ---------------------------------------------------------------------------

server.registerTool(
  "googlehealth_get_data_point",
  {
    title: "Get Data Point",
    description:
      "Retrieve a single identifiable health data point by its ID.\n\n" +
      "Required scope: depends on data type category.",
    inputSchema: {
      data_type: dataTypeEnum.describe("The health data type (kebab-case)"),
      data_point_id: z.string().min(1).describe("The unique identifier of the data point"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ data_type, data_point_id }) => safeTool(async () =>
    jsonResult(await makeApiRequest(`users/me/dataTypes/${data_type}/dataPoints/${data_point_id}`))
  )
);

// ---------------------------------------------------------------------------
// Tool: daily roll-up
// ---------------------------------------------------------------------------

function formatRollUpMarkdown(data: Record<string, unknown>, dataType: string, label: string): string {
  const buckets = Array.isArray(data.rollupDataPoints) ? data.rollupDataPoints : [];
  const lines: string[] = [`# ${dataType} — ${label}`, "", `${buckets.length} bucket(s) returned.`, ""];
  for (const b of buckets) {
    const bucket = b as Record<string, unknown>;
    const civilStart = bucket.civilStartTime as Record<string, unknown> | undefined;
    const start = civilStart
      ? formatCivilDate(civilStart)
      : (bucket.startTime ?? "?");
    const civilEnd = bucket.civilEndTime as Record<string, unknown> | undefined;
    const end = civilEnd
      ? formatCivilDate(civilEnd)
      : (bucket.endTime ?? "?");
    lines.push(`## ${start} → ${end}`);
    const skip = new Set(["name", "interval", "civilStartTime", "civilEndTime", "startTime", "endTime"]);
    for (const [k, v] of Object.entries(bucket)) {
      if (!skip.has(k) && v !== undefined) {
        lines.push(`- **${k}**: ${typeof v === "object" ? JSON.stringify(v) : v}`);
      }
    }
    lines.push("");
  }
  if (data.nextPageToken) lines.push(`*More results available — use page_token: "${data.nextPageToken}"*`);
  return lines.join("\n");
}

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
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").describe("Start date inclusive (e.g. '2026-06-09')"),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").describe("End date exclusive (e.g. '2026-06-16' to include June 15)"),
      window_size_days: z.number().int().min(1).default(1).describe("Number of days per bucket (default 1)"),
      ...paginationSchema,
      response_format: responseFormatSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ data_type, start_date, end_date, window_size_days, page_size, page_token, response_format }) => safeTool(async () => {
    const [sy, sm, sd] = start_date.split("-").map(Number);
    const [ey, em, ed] = end_date.split("-").map(Number);
    const data = await makeApiRequest<Record<string, unknown>>(
      `users/me/dataTypes/${data_type}/dataPoints:dailyRollUp`, "POST",
      {
        range: {
          start: { date: { year: sy, month: sm, day: sd }, time: { hours: 0, minutes: 0, seconds: 0 } },
          end: { date: { year: ey, month: em, day: ed }, time: { hours: 0, minutes: 0, seconds: 0 } },
        },
        windowSizeDays: window_size_days,
        pageSize: page_size,
        ...(page_token ? { pageToken: page_token } : {}),
      }
    );
    const text = response_format === ResponseFormat.MARKDOWN
      ? formatRollUpMarkdown(data, data_type, `Daily ${start_date} to ${end_date}`)
      : JSON.stringify(data, null, 2);
    return { content: [{ type: "text", text: truncateIfNeeded(text) }] };
  })
);

// ---------------------------------------------------------------------------
// Tool: roll-up (physical time)
// ---------------------------------------------------------------------------

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
      window_size: z.string().describe("Aggregation window as duration (e.g. '30s', '3600s' for 1 hour, '86400s' for 1 day)"),
      ...paginationSchema,
      response_format: responseFormatSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ data_type, start_time, end_time, window_size, page_size, page_token, response_format }) => safeTool(async () => {
    const data = await makeApiRequest<Record<string, unknown>>(
      `users/me/dataTypes/${data_type}/dataPoints:rollUp`, "POST",
      {
        range: { startTime: start_time, endTime: end_time },
        windowSize: window_size,
        pageSize: page_size,
        ...(page_token ? { pageToken: page_token } : {}),
      }
    );
    const text = response_format === ResponseFormat.MARKDOWN
      ? formatRollUpMarkdown(data, data_type, `${start_time} to ${end_time} (window: ${window_size})`)
      : JSON.stringify(data, null, 2);
    return { content: [{ type: "text", text: truncateIfNeeded(text) }] };
  })
);

// ---------------------------------------------------------------------------
// Tool: reconcile data points
// ---------------------------------------------------------------------------

server.registerTool(
  "googlehealth_reconcile",
  {
    title: "Reconcile Data Points",
    description:
      "Reconcile health data points from multiple data sources (e.g. Fitbit, Pixel Watch, third-party apps). " +
      "Returns deduplicated, source-prioritised data.\n\n" +
      "Required scope: depends on data type category.",
    inputSchema: {
      data_type: dataTypeEnum.describe("The health data type (kebab-case)"),
      filter: z.string().optional().describe("Filter expression for time range"),
      ...paginationSchema,
      response_format: responseFormatSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ data_type, filter, page_size, page_token, response_format }) => safeTool(async () => {
    const data = await makeApiRequest<Record<string, unknown>>(
      `users/me/dataTypes/${data_type}/dataPoints:reconcile`, "GET", undefined,
      { filter, pageSize: page_size, pageToken: page_token }
    );
    const text = response_format === ResponseFormat.MARKDOWN
      ? formatDataPointsMarkdown(data, `${data_type} (reconciled)`)
      : JSON.stringify(data, null, 2);
    return { content: [{ type: "text", text: truncateIfNeeded(text) }] };
  })
);

// ---------------------------------------------------------------------------
// Tool: export exercise as TCX
// ---------------------------------------------------------------------------

server.registerTool(
  "googlehealth_export_exercise_tcx",
  {
    title: "Export Exercise TCX",
    description:
      "Export an exercise data point in TCX format (Training Center XML). Useful for importing workouts into other fitness platforms.\n\n" +
      "Required scope: googlehealth.activity_and_fitness.readonly (and googlehealth.location.readonly for GPS data)",
    inputSchema: {
      data_point_id: z.string().min(1).describe("The exercise data point ID to export"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ data_point_id }) => safeTool(async () => {
    const data = await makeApiRequest(
      `users/me/dataTypes/exercise/dataPoints/${data_point_id}:exportExerciseTcx`
    );
    return {
      content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
    };
  })
);

// ---------------------------------------------------------------------------
// Tool: list paired devices
// ---------------------------------------------------------------------------

server.registerTool(
  "googlehealth_list_devices",
  {
    title: "List Paired Devices",
    description:
      "Returns the user's list of paired trackers and smartwatches (Fitbit, Pixel Watch, etc.).\n\n" +
      "Required scope: googlehealth.settings.readonly",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => safeTool(async () => jsonResult(await makeApiRequest("users/me/pairedDevices")))
);

// ---------------------------------------------------------------------------
// Tool: get device details
// ---------------------------------------------------------------------------

server.registerTool(
  "googlehealth_get_device",
  {
    title: "Get Device Details",
    description:
      "Returns details for a specific paired device by ID.\n\n" +
      "Required scope: googlehealth.settings.readonly",
    inputSchema: {
      device_id: z.string().min(1).describe("The paired device ID"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ device_id }) => safeTool(async () =>
    jsonResult(await makeApiRequest(`users/me/pairedDevices/${device_id}`))
  )
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Google Health MCP server running via stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
