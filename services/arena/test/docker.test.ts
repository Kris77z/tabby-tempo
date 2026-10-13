import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerArguments, DockerExecutor } from "../src/docker.js";
import { hiddenTests, problemCatalog } from "../src/problems.js";

const correct: Record<string, string> = {
  "sum-integers": "import json,sys\nprint(json.dumps(sum(json.load(sys.stdin))))\n",
  "unique-sorted": "import json,sys\nprint(json.dumps(sorted(set(json.load(sys.stdin)))))\n",
  "balanced-brackets": "import json,sys\ns=json.load(sys.stdin)\nstack=[]\nok=True\nfor c in s:\n if c in '([{': stack.append(c)\n elif not stack or stack.pop() != {')':'(',']':'[','}':'{'}[c]: ok=False; break\nprint(json.dumps(ok and not stack))\n",
  "word-frequency": "import json,sys,collections\nprint(json.dumps(dict(collections.Counter(json.load(sys.stdin)))))\n",
};

test("fixed Docker arguments restrict mounts, network, uid, privileges and resources", () => {
  const args = containerArguments("owned-container", "/tmp/one-submission");
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(value("--network"), "none");
  assert.equal(value("--user"), "65532:65532");
  assert.equal(value("--memory"), "64m");
  assert.equal(value("--memory-swap"), "64m");
  assert.equal(value("--cpus"), "0.5");
  assert.equal(value("--pids-limit"), "32");
  assert.equal(value("--cap-drop"), "ALL");
  assert.equal(value("--security-opt"), "no-new-privileges");
  assert.equal(value("--mount"), "type=bind,src=/tmp/one-submission,dst=/submission,readonly");
  assert.ok(args.includes("--read-only") && !args.includes("--rm")); // Own finally cleanup follows runtime-state inspection.
  assert.equal(args.filter(arg => arg === "--mount").length, 1);
  assert.ok(!args.includes("--privileged") && !args.includes("--env") && !args.includes("--env-file"));
  assert.ok(!args.join(" ").includes("docker.sock"));
  assert.deepEqual(args.slice(-5), ["-i", "/usr/local/bin/python3", "-I", "-B", "/submission/main.py"]);
  assert.ok(problemCatalog().every(problem => !Object.hasOwn(problem, "hiddenTests")));
  assert.ok(problemCatalog().every(problem => problem.language === "python3"));
});

test("actual Docker executes all four problems without exposing answers", { timeout: 120000 }, async () => {
  const runner = new DockerExecutor();
  await runner.ready(); // A missing daemon/image is a visible failure, not a skip.
  for (const problem of problemCatalog()) for (const testCase of hiddenTests(problem.id)) {
    const result = await runner.execute(correct[problem.id], testCase.input);
    assert.equal(result.failure, undefined, JSON.stringify(result));
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), testCase.expected);
  }
});

test("actual container is nonroot/read-only/offline, sees code only and receives no host env", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-host-secret-"));
  process.env.ARENA_TEST_SECRET = "only-on-host";
  try {
    await writeFile(join(directory, "secret"), "synthetic-secret");
    const code = `import os,json,socket\nresult={'uid':os.getuid(),'files':os.listdir('/submission'),'host_file':os.path.exists(${JSON.stringify(join(directory, "secret"))}),'host_env':os.getenv('ARENA_TEST_SECRET'),'path_env':os.getenv('PATH')}\nfor p,k in [('/submission/main.py','code_readonly'),('/etc/arena-write','root_readonly')]:\n try:\n  open(p,'w').write('overwrite'); result[k]=False\n except OSError: result[k]=True\nopen('/work/temporary','w').write('ok')\nresult['work']=open('/work/temporary').read()\ns=socket.socket(); s.settimeout(0.5)\ntry:\n s.connect(('1.1.1.1',80)); result['offline']=False\nexcept OSError: result['offline']=True\nresult['memory']=open('/sys/fs/cgroup/memory.max').read().strip()\nresult['pids']=open('/sys/fs/cgroup/pids.max').read().strip()\nresult['cpu']=open('/sys/fs/cgroup/cpu.max').read().strip()\nprint(json.dumps(result))\n`;
    const result = await new DockerExecutor().execute(code, "ignored\n");
    assert.equal(result.failure, undefined, JSON.stringify(result));
    const facts = JSON.parse(result.stdout);
    assert.equal(facts.uid, 65532);
    assert.deepEqual(facts.files, ["main.py"]);
    assert.equal(facts.host_file, false);
    assert.equal(facts.host_env, null);
    assert.equal(facts.path_env, null);
    assert.equal(facts.code_readonly, true);
    assert.equal(facts.root_readonly, true);
    assert.equal(facts.offline, true);
    assert.equal(facts.work, "ok");
    assert.equal(facts.memory, "67108864");
    assert.equal(facts.pids, "32");
    assert.equal(facts.cpu, "50000 100000");
  } finally { delete process.env.ARENA_TEST_SECRET; await rm(directory, { recursive: true, force: true }); }
});

test("timeout, flood, nonzero exit and cancellation fail and clean own containers/tempdirs", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-cleanup-test-"));
  const namesFile = join(directory, "names");
  const argsFile = join(directory, "arguments");
  const wrapper = join(directory, "docker-record");
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  // Record only this runner's create calls, then exec the real Docker CLI.
  // exec preserves kill/stdio behavior; no other containers are enumerated.
  await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = create ]; then\n  printf '%s\\n' "$3" >> ${shellQuote(namesFile)}\n  printf '%s\\n' "$@" >> ${shellQuote(argsFile)}\nfi\nexec docker "$@"\n`, { mode: 0o700 });
  try {
    const runner = new DockerExecutor({ dockerBin: wrapper, timeoutMs: 600, maxOutputBytes: 1024 });
    assert.equal((await runner.execute("while True: pass\n", "")).failure, "timeout");
    // These cases test output/exit classification, not a sub-second startup race on a busy daemon.
    const exitRunner = new DockerExecutor({ dockerBin: wrapper, timeoutMs: 3000, maxOutputBytes: 1024 });
    assert.equal((await exitRunner.execute("while True: print('x'*2048,flush=True)\n", "")).failure, "output-limit");
    assert.equal((await exitRunner.execute("print(5)\nraise SystemExit(1)\n", "")).failure, "runtime");
    const abort = new AbortController();
    const pending = runner.execute("while True: pass\n", "", abort.signal);
    setTimeout(() => abort.abort(), 250);
    assert.equal((await pending).failure, "cancelled");
    const ownedNames = (await readFile(namesFile, "utf8")).trim().split("\n");
    assert.equal(ownedNames.length, 4);
    for (const name of ownedNames) {
      const inspection = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn("docker", ["inspect", "--format", "{{.Id}}", name]);
        let stderr = "";
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.on("error", reject); child.on("close", code => resolve({ code, stderr }));
      });
      assert.equal(inspection.code, 1, `Own container still exists: ${name}`);
      assert.match(inspection.stderr, /No such (object|container)/i);
    }
    const ownedDirectories = (await readFile(argsFile, "utf8")).split("\n")
      .map(argument => /^type=bind,src=(.*),dst=\/submission,readonly$/.exec(argument)?.[1])
      .filter((path): path is string => Boolean(path));
    assert.equal(ownedDirectories.length, 4);
    for (const path of ownedDirectories) await assert.rejects(stat(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing Docker executable fails closed and never executes submitted code on host", async () => {
  await assert.rejects(new DockerExecutor({ dockerBin: "/definitely/not/a/docker" }).ready(), /ENOENT/);
});

test("Docker startup delay does not consume the submitted program's execution budget", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-startup-delay-")), wrapper = join(directory, "docker-delayed");
  await writeFile(wrapper, '#!/bin/sh\nif [ "$1" = start ]; then sleep 1; fi\nexec docker "$@"\n', { mode: 0o700 });
  try {
    const result = await new DockerExecutor({ dockerBin: wrapper, timeoutMs: 600 }).execute("print(9)\n", "");
    assert.equal(result.failure, undefined, JSON.stringify(result)); assert.equal(result.stdout, "9\n");
    await assert.rejects(new DockerExecutor({ dockerBin: wrapper, timeoutMs: 600, startupTimeoutMs: 100 }).execute("print(9)\n", ""), /DOCKER_START_TIMEOUT/);
    const replayMarker = "import os,re,time\nm=re.search(rb'AF_EXECUTION_STARTED_[0-9a-f-]+',open('/proc/self/cmdline','rb').read()).group()\nfor i in range(20):\n os.write(2,m+b'\\n');time.sleep(0.1)\nprint(9)\n";
    assert.equal((await new DockerExecutor({ dockerBin: wrapper, timeoutMs: 600 }).execute(replayMarker, "")).failure, "timeout", "A submitted program cannot reset its timer by replaying the visible startup marker");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Docker attach delay after container exit drains without consuming the execution budget", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-attach-delay-")), wrapper = join(directory, "docker-delayed-exit");
  await writeFile(wrapper, '#!/bin/sh\nif [ "$1" = start ]; then docker "$@"; result=$?; sleep 1; exit "$result"; fi\nexec docker "$@"\n', { mode: 0o700 });
  try {
    const result = await new DockerExecutor({ dockerBin: wrapper, timeoutMs: 600 }).execute("print(9)\n", "");
    assert.equal(result.failure, undefined, JSON.stringify(result)); assert.equal(result.stdout, "9\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
