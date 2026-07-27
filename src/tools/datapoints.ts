import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeApiRequest } from "../api-client.js";
import { formatDataPoints } from "../formatters.js";
import {
  READONLY_ANNOTATIONS,
  ResponseFormat,
  dataTypeEnum,
  jsonResult,
  paginationSchema,
  respond,
  responseFormatSchema,
  safeTool,
} from "./shared.js";

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
      description: options.description,
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
        const data = await makeApiRequest<Record<string, unknown>>(
          `users/me/dataTypes/${data_type}/dataPoints${options.pathSuffix}`,
          "GET",
          undefined,
          { filter, pageSize: page_size, pageToken: page_token }
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
      "Returns: { dataPoints: [...], nextPageToken? }\n\n" +
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
