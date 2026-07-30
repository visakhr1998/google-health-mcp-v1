import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TokenFile,
  mergeTokens,
  missingScopes,
  saveTokens,
  loadTokens,
  getTokenPath,
  loadDotEnv,
  warnIfShadowedEnv,
  resetShadowWarning,
} from "./store.js";

const base: TokenFile = {
  type: "authorized_user",
  client_id: "cid",
  client_secret: "secret",
  refresh_token: "REFRESH",
  token_uri: "https://oauth2.googleapis.com/token",
};

async function withTempTokenPath(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "gh-mcp-"));
  const path = join(dir, "token.json");
  const previous = process.env.GOOGLE_HEALTH_TOKEN_PATH;
  process.env.GOOGLE_HEALTH_TOKEN_PATH = path;
  try {
    await fn(path);
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_HEALTH_TOKEN_PATH;
    else process.env.GOOGLE_HEALTH_TOKEN_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

// The regression this guards: Google omits refresh_token from most refresh
// responses. Overwriting it with undefined is what used to strand the server
// on a dead credential and produce invalid_grant.
test("mergeTokens keeps the existing refresh token when the patch omits it", () => {
  const merged = mergeTokens(base, { access_token: "new", expiry_date: 123 });
  assert.equal(merged.refresh_token, "REFRESH");
  assert.equal(merged.access_token, "new");
  assert.equal(merged.expiry_date, 123);
});

test("mergeTokens keeps the existing refresh token when the patch has undefined", () => {
  assert.equal(mergeTokens(base, { refresh_token: undefined }).refresh_token, "REFRESH");
});

test("mergeTokens adopts a rotated refresh token", () => {
  assert.equal(mergeTokens(base, { refresh_token: "ROTATED" }).refresh_token, "ROTATED");
});

test("mergeTokens does not mutate its input", () => {
  mergeTokens(base, { access_token: "x" });
  assert.equal(base.access_token, undefined);
});

test("missingScopes reports only what was not granted", () => {
  assert.deepEqual(missingScopes(["a", "b"], ["a", "b"]), []);
  assert.deepEqual(missingScopes(["a"], ["a", "b"]), ["b"]);
  assert.deepEqual(missingScopes(undefined, ["a"]), ["a"]);
  assert.deepEqual(missingScopes([], []), []);
});

test("getTokenPath honours the environment override", async () => {
  await withTempTokenPath(async (path) => {
    assert.equal(getTokenPath(), path);
  });
});

test("saveTokens then loadTokens round-trips", async () => {
  await withTempTokenPath(async () => {
    await saveTokens({ ...base, scopes: ["a", "b"], obtained_at: 42 });
    const loaded = await loadTokens();
    assert.equal(loaded?.refresh_token, "REFRESH");
    assert.deepEqual(loaded?.scopes, ["a", "b"]);
    assert.equal(loaded?.obtained_at, 42);
  });
});

test("loadTokens returns null when no file exists", async () => {
  await withTempTokenPath(async () => {
    assert.equal(await loadTokens(), null);
  });
});

test("loadTokens gives an actionable error on a corrupt file", async () => {
  await withTempTokenPath(async (path) => {
    await writeFile(path, "{ not json");
    await assert.rejects(loadTokens(), /npm run auth/);
  });
});

test("concurrent saves serialise and leave valid JSON", async () => {
  await withTempTokenPath(async (path) => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => saveTokens({ ...base, expiry_date: i }))
    );
    const parsed = JSON.parse(await readFile(path, "utf-8")) as TokenFile;
    assert.equal(parsed.refresh_token, "REFRESH");
    assert.equal(typeof parsed.expiry_date, "number");
  });
});

test("saveTokens leaves no temp file behind", async () => {
  await withTempTokenPath(async (path) => {
    await saveTokens(base);
    await assert.rejects(readFile(`${path}.tmp`, "utf-8"));
  });
});

test("loadDotEnv parses pairs, strips quotes, and never overrides the environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gh-env-"));
  const envPath = join(dir, ".env");
  await writeFile(
    envPath,
    ["# comment", "", "PLAIN=one", 'QUOTED="two"', "SINGLE='three'", "PREEXISTING=fromfile"].join("\n")
  );

  process.env.PREEXISTING = "fromenv";
  try {
    loadDotEnv(envPath);
    assert.equal(process.env.PLAIN, "one");
    assert.equal(process.env.QUOTED, "two");
    assert.equal(process.env.SINGLE, "three");
    assert.equal(process.env.PREEXISTING, "fromenv");
  } finally {
    delete process.env.PLAIN;
    delete process.env.QUOTED;
    delete process.env.SINGLE;
    delete process.env.PREEXISTING;
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadDotEnv is a no-op when the file is absent", () => {
  const result = loadDotEnv(join(tmpdir(), "definitely-not-here", ".env"));
  assert.deepEqual(result, { applied: [], shadowed: [] });
});

async function withEnvFile(lines: string[], fn: (path: string) => void | Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "gh-env-"));
  const path = join(dir, ".env");
  await writeFile(path, lines.join("\n"));
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The failure this guards: a stale persistent environment variable pointing at
// a retired OAuth client shadows a correct .env, and the only visible symptom
// is invalid_grant with no explanation.
test("loadDotEnv reports a shadowed key when the environment differs", async () => {
  await withEnvFile(["GOOGLE_HEALTH_CLIENT_ID=from-file"], (path) => {
    process.env.GOOGLE_HEALTH_CLIENT_ID = "from-environment";
    try {
      const result = loadDotEnv(path);
      assert.deepEqual(result.applied, []);
      assert.equal(result.shadowed.length, 1);
      assert.deepEqual(result.shadowed[0], {
        key: "GOOGLE_HEALTH_CLIENT_ID",
        fileValue: "from-file",
        envValue: "from-environment",
      });
    } finally {
      delete process.env.GOOGLE_HEALTH_CLIENT_ID;
    }
  });
});

test("loadDotEnv does not report a shadow when the values agree", async () => {
  await withEnvFile(["SAME_VALUE=identical"], (path) => {
    process.env.SAME_VALUE = "identical";
    try {
      assert.deepEqual(loadDotEnv(path).shadowed, []);
    } finally {
      delete process.env.SAME_VALUE;
    }
  });
});

test("loadDotEnv treats a blank placeholder as unfilled, not a conflict", async () => {
  await withEnvFile(["BLANK_PLACEHOLDER="], (path) => {
    process.env.BLANK_PLACEHOLDER = "something";
    try {
      assert.deepEqual(loadDotEnv(path).shadowed, []);
    } finally {
      delete process.env.BLANK_PLACEHOLDER;
    }
  });
});

test("loadDotEnv records keys it applied", async () => {
  await withEnvFile(["FRESH_KEY=value"], (path) => {
    try {
      assert.deepEqual(loadDotEnv(path).applied, ["FRESH_KEY"]);
    } finally {
      delete process.env.FRESH_KEY;
    }
  });
});

test("warnIfShadowedEnv hides secrets but shows client IDs", () => {
  resetShadowWarning();
  const messages: string[] = [];
  const original = console.error;
  console.error = (m: string) => messages.push(m);
  try {
    warnIfShadowedEnv({
      applied: [],
      shadowed: [
        { key: "GOOGLE_HEALTH_CLIENT_ID", fileValue: "new-id", envValue: "stale-id" },
        { key: "GOOGLE_HEALTH_CLIENT_SECRET", fileValue: "NEWSECRET", envValue: "OLDSECRET" },
      ],
    });
  } finally {
    console.error = original;
  }

  const output = messages.join("\n");
  assert.match(output, /stale-id/);
  assert.match(output, /new-id/);
  assert.match(output, /values hidden/);
  assert.doesNotMatch(output, /OLDSECRET|NEWSECRET/);
});

test("warnIfShadowedEnv stays silent with nothing shadowed, and fires only once", () => {
  resetShadowWarning();
  let calls = 0;
  const original = console.error;
  console.error = () => calls++;
  try {
    warnIfShadowedEnv({ applied: [], shadowed: [] });
    assert.equal(calls, 0, "no conflict should produce no output");

    const conflict = {
      applied: [],
      shadowed: [{ key: "K", fileValue: "a", envValue: "b" }],
    };
    warnIfShadowedEnv(conflict);
    warnIfShadowedEnv(conflict);
    assert.equal(calls, 1, "repeat refreshes must not repeat the warning");
  } finally {
    console.error = original;
    resetShadowWarning();
  }
});
