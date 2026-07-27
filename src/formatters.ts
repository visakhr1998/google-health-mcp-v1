// Markdown renderings of Google Health payloads. Pure functions — unit-tested
// directly, no network involved.

/** Renders a civil-time object ({date:{year,month,day}}) as YYYY-MM-DD. */
export function formatCivilDate(civil: Record<string, unknown>): string {
  const d = civil.date as Record<string, number> | undefined;
  if (!d) return JSON.stringify(civil);
  const year = d.year;
  const month = String(d.month).padStart(2, "0");
  const day = String(d.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Dumps an object's remaining fields as markdown bullets. The API returns a
 * different shape per data type, so rather than model 40 schemas we render
 * whatever came back and let the caller skip the keys it has already shown.
 */
export function formatEntries(
  source: Record<string, unknown>,
  skip: ReadonlySet<string>
): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (skip.has(key) || value === undefined) continue;
    lines.push(`- **${key}**: ${typeof value === "object" ? JSON.stringify(value) : value}`);
  }
  return lines;
}

export function paginationFooter(data: Record<string, unknown>): string[] {
  return data.nextPageToken
    ? [`*More results available — use page_token: "${data.nextPageToken}"*`]
    : [];
}

const DATA_POINT_SKIP: ReadonlySet<string> = new Set(["name", "interval"]);

export function formatDataPoints(data: Record<string, unknown>, dataType: string): string {
  const points = Array.isArray(data.dataPoints) ? data.dataPoints : [];
  const lines: string[] = [
    `# ${dataType} Data Points`,
    "",
    `Found ${points.length} data point(s).`,
    "",
  ];

  for (const point of points) {
    const p = point as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name.split("/").pop() : "unknown";
    lines.push(`## ${name}`);

    if (p.interval && typeof p.interval === "object") {
      const interval = p.interval as Record<string, unknown>;
      if (interval.startTime) lines.push(`- **Start**: ${interval.startTime}`);
      if (interval.endTime) lines.push(`- **End**: ${interval.endTime}`);
    }

    lines.push(...formatEntries(p, DATA_POINT_SKIP), "");
  }

  lines.push(...paginationFooter(data));
  return lines.join("\n");
}

const ROLLUP_SKIP: ReadonlySet<string> = new Set([
  "name",
  "interval",
  "civilStartTime",
  "civilEndTime",
  "startTime",
  "endTime",
]);

export function formatRollUp(
  data: Record<string, unknown>,
  dataType: string,
  label: string
): string {
  const buckets = Array.isArray(data.rollupDataPoints) ? data.rollupDataPoints : [];
  const lines: string[] = [`# ${dataType} — ${label}`, "", `${buckets.length} bucket(s) returned.`, ""];

  for (const bucket of buckets) {
    const b = bucket as Record<string, unknown>;
    const civilStart = b.civilStartTime as Record<string, unknown> | undefined;
    const civilEnd = b.civilEndTime as Record<string, unknown> | undefined;
    const start = civilStart ? formatCivilDate(civilStart) : (b.startTime ?? "?");
    const end = civilEnd ? formatCivilDate(civilEnd) : (b.endTime ?? "?");

    lines.push(`## ${start} → ${end}`, ...formatEntries(b, ROLLUP_SKIP), "");
  }

  lines.push(...paginationFooter(data));
  return lines.join("\n");
}
