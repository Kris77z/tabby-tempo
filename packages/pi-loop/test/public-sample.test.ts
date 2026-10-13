import assert from "node:assert/strict";
import test from "node:test";
import { problemCatalog } from "@agentfuel/arena";
import { hiddenTests } from "../../../services/arena/src/problems.js";
import { DockerExecutor, type Execution } from "@agentfuel/arena/docker";
import { PUBLIC_SAMPLE, publicSampleFor, testPublicSample } from "../src/public-sample.js";

test("fixed public samples preserve the original sum prompt and are disjoint from hidden cases", () => {
  assert.equal(publicSampleFor("sum-integers"), PUBLIC_SAMPLE);
  assert.equal(PUBLIC_SAMPLE.prompt, "Write Python 3.12 code that reads a JSON array of integers from stdin and prints its sum as JSON. Public sample: [4,8,-3] -> 9. Call test_public_sample with your complete code. Fix failures. Do not claim task success: only the independent Arena can accept it.");
  assert.equal(PUBLIC_SAMPLE.input, "[4,8,-3]\n"); assert.equal(PUBLIC_SAMPLE.expected, 9);
  for (const problem of problemCatalog()) {
    const sample = publicSampleFor(problem.id); assert.equal(sample.problemId, problem.id); assert.equal(Object.isFrozen(sample), true);
    assert.deepEqual(Object.keys(sample).sort(), ["expected", "input", "problemId", "prompt"]);
    assert.equal(hiddenTests(problem.id).some(test => test.input === sample.input), false);
    assert.equal(JSON.stringify(sample).includes("hiddenTests"), false);
    if (problem.id !== "sum-integers") assert.ok(sample.prompt.startsWith(problem.prompt));
  }
  for (const value of ["constructor", "unknown", "__proto__", null]) assert.throws(() => publicSampleFor(value as any), /UNKNOWN_FIXED_PROBLEM/);
});

test("public qualification compares arrays and objects by value, with the selected fixed input", async () => {
  for (const problem of problemCatalog()) {
    const sample = publicSampleFor(problem.id);
    const runner = new class extends DockerExecutor {
      override async execute(_code: string, input: string): Promise<Execution> {
        assert.equal(input, sample.input);
        const expected = problem.id === "word-frequency" ? { apple: 1, pear: 2 } : sample.expected;
        return { stdout: JSON.stringify(expected), exitCode: 0 };
      }
    };
    assert.equal((await testPublicSample(runner, "code", undefined, problem.id)).passed, true);
  }
});
