import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const launcher = new URL("../check-bounded-economy.mjs", import.meta.url);
const run = (args, endpoint = "tcp://127.0.0.1:65535") => {
  const child = spawnSync(process.execPath, [launcher.pathname, ...args], { cwd: root,
    env: { ...process.env, DOCKER_HOST: endpoint, MODEL_API_KEY: "audit-must-not-appear-in-output" }, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.equal(`${child.stdout}${child.stderr}`.includes("audit-must-not-appear-in-output"), false);
  return JSON.parse(child.stdout);
};

test("audit: launcher rejects remote Docker before starting any local worker, including opt-in execution", () => {
  for (const endpoint of ["tcp://127.0.0.1:65535", "ssh://example.invalid", "http://example.invalid"]) {
    for (const args of [[], ["--execute-local"]]) {
      const report = run(args, endpoint);
      assert.equal(report.status, "failed");
      assert.equal(report.error, "LOCAL_UNIX_DOCKER_DAEMON_REQUIRED");
      assert.equal(report.cleanup.privateTempDirectoryRemoved, true);
      assert.deepEqual(report.cleanup.failures, []);
    }
  }
});

test("audit: launcher cannot overwrite earlier evidence or silently accept execution-like flags", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentfuel-launcher-audit-"));
  try {
    const target = join(directory, "existing.json"), original = "preserve-original-evidence\n";
    writeFileSync(target, original, { flag: "wx", mode: 0o600 });
    assert.equal(run(["--report", target]).error, "REPORT_ALREADY_EXISTS");
    assert.equal(readFileSync(target, "utf8"), original);
    for (const args of [["--execute"], ["--yes"], ["--report", "relative.json"], ["--execute-local", "--execute-local"]]) {
      assert.equal(run(args).error, "USAGE_EXPECTS_EXECUTE_LOCAL_AND_OPTIONAL_ABSOLUTE_REPORT_PATH");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
