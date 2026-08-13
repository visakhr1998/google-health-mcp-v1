import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeApiRequest } from "../api-client.js";
import { formatDataPoints } from "../formatters.js";
import {
  READONLY_ANNOTATIONS,
  ResponseFormat,
  TRUNCATION_CAUTION,
  WIDE_WINDOW_GUIDANCE,
  dataTypeEnum,
  fetchNonEmptyPage,
  jsonResult,
  paginationSchema,
  respond,
  responseFormatSchema,
  safeTool,
} from "./shared.js";

/**
 * `filter` only matches on time range; it cannot select by exercise subtype,
 * activity name, or any other field. A model searching for something
 * specific (e.g. "my last run" among mixed exercise entries) has no
 * server-side way to ask for that subtype, so the only correct move is to
 * pull a wide window in one call and inspect each result itself — not to
 * guess narrower filters or re-query on a hunch.
 */
const SEARCH_TOOL_GUIDANCE =
  WIDE_WINDOW_GUIDANCE +
  " `filter` only matches on time range — it cannot select by exercise subtype, activity " +
  "name, or any other field. To find something specific, pull the wide window in one call " +
  "and inspect each result's fields yourself. When pulling a wide window, also raise " +
  "page_size toward its max (100) rather than paging through it in small steps." +
  TRUNCATION_CAUTION;

/**
 * `list` and `reconcile` take the same arguments and return the same shape;
 * only the endpoint suffix and the heading differ.
 */
function registerQueryTool(
  server: McpServer,
  options: {
    name: string;
    title: string;
    description: string;
    pathSuffix: string;
    label: (dataType: string) => string;
  }
): void {
  server.registerTool(
    options.name,
    {
      title: options.title,
      description: options.description + SEARCH_TOOL_GUIDANCE,
      inputSchema: {
        data_type: dataTypeEnum.describe(
          "The health data type to query (kebab-case, e.g. 'steps', 'heart-rate', 'sleep')"
        ),
        filter: z
          .string()
          .optional()
          .describe(
            "Filter expression for time range. Use snake_case for data type names in filters. " +
              'Example: \'data_type.interval.start_time >= "2025-06-01T00:00:00Z"\''
          ),
        ...paginationSchema,
        response_format: responseFormatSchema,
      },
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ data_type, filter, page_size, page_token, response_format }) =>
      safeTool(async () => {
        // Skips empty-but-tokened pages, which upstream emits over sparse ranges.
        const data = await fetchNonEmptyPage(
          (pageToken) =>
            makeApiRequest<Record<string, unknown>>(
              `users/me/dataTypes/${data_type}/dataPoints${options.pathSuffix}`,
              "GET",
              undefined,
              { filter, pageSize: page_size, pageToken }
            ),
          "dataPoints",
          page_token
        );
        return respond(data, response_format as ResponseFormat, (d) =>
          formatDataPoints(d, options.label(data_type))
        );
      })
  );
}

export function registerDataPointTools(server: McpServer): void {
  registerQueryTool(server, {
    name: "googlehealth_list_data_points",
    title: "List Health Data Points",
    pathSuffix: "",
    label: (t) => t,
    description:
      "Query health and fitness data points for a specific data type. Supports filtering by time range and pagination.\n\n" +
      "Supported data types include: steps, heart-rate, sleep, exercise, weight, body-fat, blood-glucose, " +
      "active-minutes, distance, floors, total-calories, nutrition-log, and many more.\n\n" +
      "Time filtering examples:\n" +
      '  - filter: \'data_type.interval.start_time >= "2025-01-01T00:00:00Z"\'\n' +
      '  - filter: \'data_type.interval.start_time >= "2025-01-01T00:00:00Z" AND data_type.interval.end_time <= "2025-01-31T23:59:59Z"\'\n\n' +
      "Note: use kebab-case for data_type param but snake_case for data type names inside filter expressions.\n\n" +
      "Returns: { dataPoints: [...], nextPageToken?, hasMore }\n" +
      "Pagination: continue while hasMore is true. Do NOT stop on an empty dataPoints array — upstream paging over sparse ranges can return an empty page that still has more data after it. The server skips most of these, but only hasMore is authoritative.\n" +
      "If the result is too large it is trimmed to whole records and marked truncated:true with truncationInfo; the JSON always parses.\n\n" +
      "Required scope: depends on data type category (activity_and_fitness, health_metrics_and_measurements, sleep, nutrition).",
  });

  registerQueryTool(server, {
    name: "googlehealth_reconcile",
    title: "Reconcile Data Points",
    pathSuffix: ":reconcile",
    label: (t) => `${t} (reconciled)`,
    description:
      "Reconcile health data points from multiple data sources (e.g. Fitbit, Pixel Watch, third-party apps). " +
      "Returns deduplicated, source-prioritised data.\n\n" +
      "Required scope: depends on data type category.",
  });

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
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ data_type, data_point_id }) =>
      safeTool(async () =>
        jsonResult(
          await makeApiRequest(`users/me/dataTypes/${data_type}/dataPoints/${data_point_id}`)
        )
      )
  );
}
