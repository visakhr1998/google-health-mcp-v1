import test from "node:test";
import assert from "node:assert/strict";
import {
  formatCivilDate,
  formatEntries,
  paginationFooter,
  formatDataPoints,
  formatRollUp,
} from "./formatters.js";

test("formatCivilDate zero-pads month and day", () => {
  assert.equal(formatCivilDate({ date: { year: 2026, month: 6, day: 9 } }), "2026-06-09");
  assert.equal(formatCivilDate({ date: { year: 2026, month: 12, day: 25 } }), "2026-12-25");
});

test("formatCivilDate falls back to JSON when there is no date", () => {
  assert.equal(formatCivilDate({ nope: 1 }), '{"nope":1}');
});

test("formatEntries skips listed keys and undefined values", () => {
  const lines = formatEntries({ a: 1, b: undefined, name: "x", c: "y" }, new Set(["name"]));
  assert.deepEqual(lines, ["- **a**: 1", "- **c**: y"]);
});

test("formatEntries JSON-encodes object values", () => {
  assert.deepEqual(formatEntries({ v: { n: 3 } }, new Set()), ['- **v**: {"n":3}']);
});

test("paginationFooter appears only when there is a next page", () => {
  assert.deepEqual(paginationFooter({}), []);
  assert.deepEqual(paginationFooter({ nextPageToken: "abc" }), [
    '*More results available — use page_token: "abc"*',
  ]);
});

test("formatDataPoints renders count, id, interval and fields", () => {
  const out = formatDataPoints(
    {
      dataPoints: [
        {
          name: "users/me/dataTypes/steps/dataPoints/xyz",
          interval: { startTime: "2026-06-13T00:00:00Z", endTime: "2026-06-14T00:00:00Z" },
          steps: 12345,
        },
      ],
    },
    "steps"
  );

  assert.match(out, /# steps Data Points/);
  assert.match(out, /Found 1 data point\(s\)/);
  assert.match(out, /## xyz/);
  assert.match(out, /- \*\*Start\*\*: 2026-06-13T00:00:00Z/);
  assert.match(out, /- \*\*steps\*\*: 12345/);
  // `interval` was rendered explicitly, so it must not be dumped again.
  assert.doesNotMatch(out, /- \*\*interval\*\*/);
});

test("formatDataPoints handles an empty payload", () => {
  const out = formatDataPoints({}, "sleep");
  assert.match(out, /Found 0 data point\(s\)/);
});

test("formatRollUp prefers civil dates over raw timestamps", () => {
  const out = formatRollUp(
    {
      rollupDataPoints: [
        {
          civilStartTime: { date: { year: 2026, month: 6, day: 9 } },
          civilEndTime: { date: { year: 2026, month: 6, day: 10 } },
          startTime: "ignored",
          steps: { count: 9000 },
        },
      ],
      nextPageToken: "next",
    },
    "steps",
    "Daily"
  );

  assert.match(out, /## 2026-06-09 → 2026-06-10/);
  assert.match(out, /- \*\*steps\*\*: \{"count":9000\}/);
  assert.doesNotMatch(out, /ignored/);
  assert.match(out, /use page_token: "next"/);
});

test("formatRollUp falls back to physical timestamps", () => {
  const out = formatRollUp(
    { rollupDataPoints: [{ startTime: "2026-06-01T00:00:00Z", endTime: "2026-06-01T01:00:00Z" }] },
    "steps",
    "Hourly"
  );
  assert.match(out, /## 2026-06-01T00:00:00Z → 2026-06-01T01:00:00Z/);
});
