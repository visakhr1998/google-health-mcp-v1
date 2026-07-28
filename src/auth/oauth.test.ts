import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { browserCommand } from "./oauth.js";

// A representative OAuth URL: many `&`-joined parameters, response_type late in
// the string so truncation is detectable.
const AUTH_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent" +
  "&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgooglehealth.sleep.readonly" +
  "&state=abc123&code_challenge=xyz&code_challenge_method=S256&response_type=code" +
  "&client_id=1234.apps.googleusercontent.com&redirect_uri=http%3A%2F%2F127.0.0.1%3A12550";

// The regression: `cmd /c start` treats & as a command separator, so the URL was
// cut after access_type=offline and Google replied "Required parameter is
// missing: response_type".
test("windows does not route the URL through cmd.exe", () => {
  const [command] = browserCommand("win32", AUTH_URL);
  assert.doesNotMatch(command, /^cmd(\.exe)?$/i, "cmd.exe would truncate the URL at the first &");
});

test("each platform passes the URL as one intact argument", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const [, args] = browserCommand(platform, AUTH_URL);
    const urlArgs = args.filter((a) => a.includes("accounts.google.com"));
    assert.equal(urlArgs.length, 1, `${platform}: URL should appear exactly once`);
    assert.equal(urlArgs[0], AUTH_URL, `${platform}: URL must not be split or altered`);
    assert.match(urlArgs[0], /response_type=code/, `${platform}: response_type must survive`);
  }
});

test("platforms map to their expected openers", () => {
  assert.equal(browserCommand("win32", AUTH_URL)[0], "explorer.exe");
  assert.equal(browserCommand("darwin", AUTH_URL)[0], "open");
  assert.equal(browserCommand("linux", AUTH_URL)[0], "xdg-open");
  assert.equal(browserCommand("freebsd", AUTH_URL)[0], "xdg-open");
});

// Proves the underlying platform behaviour rather than trusting the claim.
test("cmd.exe really does truncate at & (documents why win32 avoids it)", { skip: process.platform !== "win32" }, () => {
  const throughCmd = spawnSync("cmd", ["/c", "echo", AUTH_URL], { encoding: "utf8" });
  assert.doesNotMatch(
    (throughCmd.stdout ?? "").trim(),
    /response_type=code/,
    "if cmd stops truncating, this test can go — but the direct spawn is still correct"
  );

  const direct = spawnSync(process.execPath, ["-e", "console.log(process.argv[1])", AUTH_URL], {
    encoding: "utf8",
  });
  assert.match((direct.stdout ?? "").trim(), /response_type=code/);
});
