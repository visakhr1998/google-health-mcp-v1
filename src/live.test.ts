// Tier 5 — live end-to-end against the real Google Health API.
//
// Gated: runs only with GOOGLE_HEALTH_LIVE_TESTS=1 and a signed-in token.json
// (`npm run auth`). Never part of `npm test` or CI, because it needs a real
// account and network.
//
//   GOOGLE_HEALTH_LIVE_TESTS=1 npm run test:live
//
// The expected values come from evaluation.xml, whose answers were verified
// by hand against this account. They are deterministic historical data, which
// is what makes them a usable regression oracle: if Google changes a response
// shape, these break while the unit tests stay green.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIVE = process.env.GOOGLE_HEALTH_LIVE_TESTS === "1";
const skip = LIVE
  ? false
  : "live test — set GOOGLE_HEALTH_LIVE_TESTS=1 and run `npm run auth` first";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal MCP stdio client — exercises the real protocol, not the tools directly. */
class McpProbe {
  private child!: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, (msg: Record<string, any>) => void>();
  private buffer = "";
  readonly stderr: string[] = [];

  async start(): Promise<void> {
    this.child = spawn("node", ["dist/index.js"], {
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stderr.on("data", (d: Buffer) => this.stderr.push(d.toString()));
    this.child.stdout.on("data", (d: Buffer) => {
      this.buffer += d.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        // Also the stdout-purity guard: anything non-JSON here would throw.
        const msg = JSON.parse(line);
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });

    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "live-test", version: "1" },
    });
    this.notify("notifications/initialized");
  }

  private notify(method: string): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  send(method: string, params?: unknown): Promise<Record<string, any>> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const res = await this.send("tools/call", { name, arguments: args });
    assert.equal(res.error, undefined, `transport error from ${name}: ${JSON.stringify(res.error)}`);
    const text = res.result.content[0].text as string;
    assert.notEqual(res.result.isError, true, `${name} returned an error: ${text}`);
    return text;
  }

  callJson<T = Record<string, any>>(name: string, args?: Record<string, unknown>): Promise<T> {
    return this.callTool(name, args).then((t) => JSON.parse(t) as T);
  }

  stop(): void {
    this.child?.kill();
  }
}

const probe = new McpProbe();

before(async () => {
  if (!LIVE) return;
  await probe.start();
});

after(() => {
  if (!LIVE) return;
  probe.stop();
});

/** YYYY-MM-DD from a civil-time object. */
function civilDate(civil: { date?: { year: number; month: number; day: number } }): string {
  const d = civil.date;
  if (!d) return "?";
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

test("exposes exactly the 11 read-only tools", { skip }, async () => {
  const res = await probe.send("tools/list");
  const names = (res.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
  assert.equal(names.length, 11);
  assert.ok(!names.includes("googlehealth_set_token"), "set_token was removed");
});

// evaluation.xml: "What timezone is configured?" -> Europe/Paris
// Note the field is `timeZone`, not `timezone`.
test("get_settings returns the configured timezone", { skip }, async () => {
  const settings = await probe.callJson("googlehealth_get_settings");
  assert.equal(settings.timeZone, "Europe/Paris");
});

// evaluation.xml: "What is the legacy user ID?" -> D46NXC
test("get_identity returns the legacy user id", { skip }, async () => {
  assert.match(await probe.callTool("googlehealth_get_identity"), /D46NXC/);
});

// evaluation.xml: "device version (model name) of the paired tracker" -> Inspire 3
test("list_devices returns the paired tracker model", { skip }, async () => {
  assert.match(await probe.callTool("googlehealth_list_devices"), /Inspire 3/);
});

test("get_profile returns a profile for the account", { skip }, async () => {
  const profile = await probe.callJson("googlehealth_get_profile");
  assert.ok(profile.name, "profile should carry a resource name");
});

// evaluation.xml: peak step day over 2026-06-09..16 (end exclusive) -> 2026-06-13
//
// Two shape details this pins, both of which are easy to get wrong:
//   - the value is `steps.countSum`, and it is a STRING
//   - buckets come back in DESCENDING date order
test("daily_rollup finds the peak step day", { skip }, async () => {
  const data = await probe.callJson("googlehealth_daily_rollup", {
    data_type: "steps",
    start_date: "2026-06-09",
    end_date: "2026-06-16",
  });

  const buckets = data.rollupDataPoints ?? [];
  assert.equal(buckets.length, 7, "closed-open range should yield 7 days");

  let peakDate = "?";
  let peakSteps = -1;
  for (const bucket of buckets) {
    const steps = Number(bucket.steps?.countSum ?? 0);
    assert.ok(Number.isFinite(steps), "countSum should parse as a number");
    if (steps > peakSteps) {
      peakSteps = steps;
      peakDate = civilDate(bucket.civilStartTime ?? {});
    }
  }

  assert.equal(peakDate, "2026-06-13");
  assert.equal(peakSteps, 20105);
});

test("daily_rollup honours the exclusive end date", { skip }, async () => {
  const data = await probe.callJson("googlehealth_daily_rollup", {
    data_type: "steps",
    start_date: "2026-06-09",
    end_date: "2026-06-10",
  });
  const dates = (data.rollupDataPoints ?? []).map((b: any) => civilDate(b.civilStartTime ?? {}));
  assert.deepEqual(dates, ["2026-06-09"], "end_date is exclusive");
});

test("markdown response format renders headings", { skip }, async () => {
  const text = await probe.callTool("googlehealth_daily_rollup", {
    data_type: "steps",
    start_date: "2026-06-09",
    end_date: "2026-06-11",
    response_format: "markdown",
  });
  assert.match(text, /^# steps —/m);
  assert.match(text, /^## 2026-06-\d{2} → 2026-06-\d{2}$/m);
});

// Issue #19: the field path must be prefixed with the actual data type name
// (snake_case), not the literal word "data_type" the old docs showed — that
// literal string was never valid and every previous version of this test
// passed without ever exercising `filter` at all.
test("list_data_points accepts a time filter", { skip }, async () => {
  const data = await probe.callJson("googlehealth_list_data_points", {
    data_type: "steps",
    filter: 'steps.interval.start_time >= "2026-06-09T00:00:00Z"',
    page_size: 5,
  });
  assert.ok(Array.isArray(data.dataPoints), "expected a dataPoints array");
  for (const point of data.dataPoints) {
    assert.ok(
      point.steps?.interval?.startTime >= "2026-06-09T00:00:00Z",
      "every point should honour the filter, not just tolerate it"
    );
  }
});

// Issue #19: `exercise` rejects `filter` entirely, on any field, regardless
// of syntax — confirmed against interval.start_time, start_time, and
// exercise_type. Pinned here so a future API change (in either direction)
// is caught instead of silently re-breaking the tool description's advice.
test("filter is rejected for exercise, not just unsupported syntax", { skip }, async () => {
  const res = await probe.send("tools/call", {
    name: "googlehealth_list_data_points",
    arguments: {
      data_type: "exercise",
      filter: 'exercise.interval.start_time >= "2026-06-09T00:00:00Z"',
    },
  });
  assert.equal(res.result?.isError, true, "exercise should reject filter, not silently ignore it");
  assert.match(res.result.content[0].text, /INVALID_DATA_POINT_FILTER_DATA_TYPE_MEMBER/);
});

// Issue #20: `exercise`'s nextPageToken is only resumable when the page_size
// that produced it was 25 or more. Below that, the token looks ordinary but
// the next call rejects it — confirmed live, not fixable on our side since
// makeApiRequest passes page_size straight through. Pinned here so a future
// change to the upstream API (in either direction) gets caught.
test("exercise page tokens under page_size 25 are not resumable", { skip }, async () => {
  const first = await probe.callJson("googlehealth_list_data_points", {
    data_type: "exercise",
    page_size: 6,
  });
  assert.ok(first.nextPageToken, "a token should still come back below the floor");

  const res = await probe.send("tools/call", {
    name: "googlehealth_list_data_points",
    arguments: { data_type: "exercise", page_size: 6, page_token: first.nextPageToken },
  });
  assert.equal(res.result?.isError, true, "the token from a sub-25 page should not be resumable");
  assert.match(res.result.content[0].text, /Invalid page token/);
});

test("exercise page tokens at page_size 25+ are resumable", { skip }, async () => {
  const first = await probe.callJson("googlehealth_list_data_points", {
    data_type: "exercise",
    page_size: 25,
  });
  assert.ok(first.nextPageToken, "expected a token — the account has more than 25 exercise points");

  const second = await probe.callJson("googlehealth_list_data_points", {
    data_type: "exercise",
    page_size: 25,
    page_token: first.nextPageToken,
  });
  assert.ok(Array.isArray(second.dataPoints), "the token should resolve to a real next page");
});

test("an invalid data type is rejected by the schema, not the API", { skip }, async () => {
  const res = await probe.send("tools/call", {
    name: "googlehealth_daily_rollup",
    arguments: { data_type: "not-a-real-type", start_date: "2026-06-09", end_date: "2026-06-10" },
  });
  const failed = res.error !== undefined || res.result?.isError === true;
  assert.ok(failed, "an out-of-enum data_type must not reach the API");
});

// ── Issue #4: truncated output must still parse ──────────────────────────────
test("an oversized response is still valid JSON", { skip }, async () => {
  const text = await probe.callTool("googlehealth_list_data_points", {
    data_type: "heart-rate",
    page_size: 100,
  });
  const data = JSON.parse(text); // used to throw: document was sliced mid-string
  assert.doesNotMatch(text, /--- Response truncated/, "prose marker must be gone");
  if (data.truncated) {
    assert.ok(data.truncationInfo.returnedRecords > 0);
    assert.ok(data.truncationInfo.omittedRecords > 0);
    assert.equal(data.truncationInfo.returnedRecords, data.dataPoints.length);
  }
});

// ── Issue #5: pagination must not rest on "empty means done" ─────────────────
test("paginated responses carry an authoritative hasMore flag", { skip }, async () => {
  const data = await probe.callJson("googlehealth_list_data_points", {
    data_type: "sleep",
    page_size: 3,
  });
  assert.equal(typeof data.hasMore, "boolean");
  assert.equal(data.hasMore, Boolean(data.nextPageToken));
});

test("walking by hasMore passes the point where empty-means-done stopped", { skip }, async () => {
  let token: string | undefined;
  let pages = 0;
  let total = 0;
  do {
    const page = await probe.callJson("googlehealth_list_data_points", {
      data_type: "sleep",
      page_size: 3,
      ...(token ? { page_token: token } : {}),
    });
    total += (page.dataPoints ?? []).length;
    token = page.hasMore ? page.nextPageToken : undefined;
    pages++;
  } while (token && pages < 40);

  // An early client stopped at 14 records by breaking on the first empty page.
  assert.ok(total > 14, `expected more than 14 records, got ${total} over ${pages} pages`);
});

// ── Issue #6: range and page size are independent ────────────────────────────
test("daily_rollup accepts ranges far longer than any page size", { skip }, async () => {
  for (const days of [30, 90, 365]) {
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = new Date(start.getTime() + days * 86_400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    const data = await probe.callJson("googlehealth_daily_rollup", {
      data_type: "steps",
      start_date: iso(start),
      end_date: iso(end),
    });
    assert.ok(Array.isArray(data.rollupDataPoints), `${days}-day range should return buckets`);
  }
});

test("max_buckets caps the merged result and says so", { skip }, async () => {
  const data = await probe.callJson("googlehealth_daily_rollup", {
    data_type: "steps",
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    max_buckets: 5,
  });
  assert.ok(data.rollupDataPoints.length <= 5);
  if (data.truncated) assert.equal(data.truncationInfo.reason, "max_buckets");
});

// The upstream rule is pageSize*window <= 90 and rangeDays <= pageSize*window,
// so a fixed page size of 90 asked for a 630-day page at window=7 and was
// rejected. The page size is now derived from the bucket count per chunk.
test("window_size_days above 1 works over a short range", { skip }, async () => {
  for (const window of [2, 7, 14, 30]) {
    const data = await probe.callJson("googlehealth_daily_rollup", {
      data_type: "steps",
      start_date: "2026-01-01",
      end_date: "2026-01-29",
      window_size_days: window,
    });
    assert.ok(
      Array.isArray(data.rollupDataPoints),
      `window_size_days=${window} should return buckets`
    );
  }
});

test("window_size_days works over a range needing several chunks", { skip }, async () => {
  // 364 days at 7-day buckets spans multiple 84-day chunks (the largest whole
  // number of weekly buckets that fits the 90-day page span).
  const data = await probe.callJson("googlehealth_daily_rollup", {
    data_type: "steps",
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    window_size_days: 7,
  });
  assert.ok(Array.isArray(data.rollupDataPoints));

  // Chunk boundaries must not split a bucket, so every start date should land
  // on the same weekday offset from the range start.
  const starts = (data.rollupDataPoints as any[])
    .map((b) => b.civilStartTime?.date)
    .filter(Boolean)
    .map((d) => Date.UTC(d.year, d.month - 1, d.day));
  const origin = Date.UTC(2026, 0, 1);
  for (const start of starts) {
    assert.equal(
      Math.round((start - origin) / 86_400_000) % 7,
      0,
      "bucket boundaries must stay aligned across chunk edges"
    );
  }
});

test("stdout carried only JSON-RPC", { skip }, () => {
  // Every stdout line was JSON.parse'd in the reader above; a stray
  // console.log would have thrown before reaching here.
  assert.ok(
    probe.stderr.join("").includes("running via stdio"),
    "startup banner belongs on stderr, never stdout"
  );
});
