import { isDeepStrictEqual } from "node:util";
import { DockerExecutor } from "@agentfuel/arena/docker";
import { problemCatalog, type ProblemId } from "@agentfuel/arena";

// Preserve the original sum sample exactly for existing paid sessions and audits.
export const PUBLIC_SAMPLE = Object.freeze({ problemId: "sum-integers", input: "[4,8,-3]\n", expected: 9,
  prompt: "Write Python 3.12 code that reads a JSON array of integers from stdin and prints its sum as JSON. Public sample: [4,8,-3] -> 9. Call test_public_sample with your complete code. Fix failures. Do not claim task success: only the independent Arena can accept it." });
export interface PublicSample { readonly problemId: ProblemId; readonly input: string; readonly expected: unknown; readonly prompt: string }
// Only the public catalog projection is used here. Hidden tests remain Arena-owned.
const examples = Object.freeze({
  "unique-sorted": Object.freeze({ input: "[4,8,4,-3]\n", expected: Object.freeze([-3, 4, 8]) }),
  "balanced-brackets": Object.freeze({ input: '"(()){[]}"\n', expected: true }),
  "word-frequency": Object.freeze({ input: '["pear","apple","pear"]\n', expected: Object.freeze({ pear: 2, apple: 1 }) }),
});
const samples = new Map<ProblemId, PublicSample>(problemCatalog().map(problem => {
  if (problem.id === PUBLIC_SAMPLE.problemId) return [problem.id, PUBLIC_SAMPLE];
  const sample = examples[problem.id];
  return [problem.id, Object.freeze({ problemId: problem.id, ...sample,
    prompt: `${problem.prompt} Public sample: ${sample.input.trim()} -> ${JSON.stringify(sample.expected)}. Call test_public_sample with your complete code. Fix failures. Do not claim task success: only the independent Arena can accept it.` })];
}));
export function isFixedProblemId(value: unknown): value is ProblemId { return typeof value === "string" && samples.has(value as ProblemId); }
export function publicSampleFor(problemId: ProblemId): PublicSample {
  const sample = samples.get(problemId); if (!sample) throw new Error("UNKNOWN_FIXED_PROBLEM"); return sample;
}
export interface SampleResult { passed: boolean; stdout: string; failure?: string }
export async function testPublicSample(runner: DockerExecutor, code: string, signal?: AbortSignal, problemId: ProblemId = "sum-integers"): Promise<SampleResult> {
  const sample = publicSampleFor(problemId), output = await runner.execute(code, sample.input, signal);
  let passed = false; let failure: string | undefined = output.failure;
  if (!failure) { try { passed = isDeepStrictEqual(JSON.parse(output.stdout.trim()), sample.expected); } catch { failure = "invalid-json"; } }
  if (!passed) failure ??= "wrong-answer";
  return { passed, stdout: output.stdout, ...(failure ? { failure } : {}) };
}
