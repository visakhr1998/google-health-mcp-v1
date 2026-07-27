import test from "node:test";
import assert from "node:assert/strict";
import { DATA_TYPES, REQUIRED_SCOPES, ALL_SCOPES, API_BASE_URL, CHARACTER_LIMIT } from "./constants.js";

test("DATA_TYPES has no duplicates", () => {
  assert.equal(new Set(DATA_TYPES).size, DATA_TYPES.length);
});

test("DATA_TYPES entries are kebab-case", () => {
  for (const type of DATA_TYPES) {
    assert.match(type, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${type} is not kebab-case`);
  }
});

test("DATA_TYPES stays sorted so additions land predictably", () => {
  assert.deepEqual([...DATA_TYPES], [...DATA_TYPES].sort());
});

test("ALL_SCOPES is a superset of REQUIRED_SCOPES", () => {
  const all = new Set<string>(ALL_SCOPES);
  for (const scope of REQUIRED_SCOPES) assert.ok(all.has(scope), `${scope} missing from ALL_SCOPES`);
});

test("scopes are well-formed googleapis URLs with no duplicates", () => {
  assert.equal(new Set(ALL_SCOPES).size, ALL_SCOPES.length);
  for (const scope of ALL_SCOPES) {
    assert.match(scope, /^https:\/\/www\.googleapis\.com\/auth\/googlehealth\.[a-z_]+\.readonly$/);
  }
});

test("API base URL is versioned and has no trailing slash", () => {
  assert.equal(API_BASE_URL, "https://health.googleapis.com/v4");
});

test("character limit is a sane positive budget", () => {
  assert.ok(CHARACTER_LIMIT > 1000 && Number.isInteger(CHARACTER_LIMIT));
});
