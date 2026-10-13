export type ProblemId = "sum-integers" | "unique-sorted" | "balanced-brackets" | "word-frequency";
export interface Problem { id: ProblemId; language: "python3"; prompt: string; reward: string }
interface HiddenTest { input: string; expected: unknown }

const definitions: Problem[] = [
  { id: "sum-integers", language: "python3", reward: "150000", prompt: "Python 3.12: read one JSON integer array from stdin. Write its sum as one JSON integer to stdout, followed by a newline. Integers can be negative; the empty array sums to 0. No other output." },
  { id: "unique-sorted", language: "python3", reward: "150000", prompt: "Python 3.12: read one JSON integer array from stdin. Write a JSON array containing each distinct integer once, in ascending order. The empty array produces []. No other output." },
  { id: "balanced-brackets", language: "python3", reward: "150000", prompt: "Python 3.12: read one JSON string containing only ()[]{} from stdin. Write the JSON boolean true if all brackets match and are correctly nested, otherwise false. The empty string is balanced. No other output." },
  { id: "word-frequency", language: "python3", reward: "150000", prompt: "Python 3.12: read one JSON array of lowercase ASCII words from stdin. Write a JSON object whose keys are distinct words and values are their occurrence counts. Object key order is irrelevant. The empty input produces {}. No other output." },
];

// This module is trusted host code. Only main.py and a single input reach Docker.
const tests: Record<ProblemId, Array<[unknown, unknown]>> = {
  "sum-integers": [[[], 0], [[2, 7, -4], 5], [[-9, -1, 3], -7], [[10000000000, 10000000000, -1], 19999999999], [[0, 0], 0]],
  "unique-sorted": [[[], []], [[3, 1, 3, -2, 1], [-2, 1, 3]], [[9], [9]], [[0, -1, 0, -1, 2], [-1, 0, 2]]],
  "balanced-brackets": [["", true], ["([]{})", true], ["([)]", false], ["((", false], ["]", false], ["{}[()]", true]],
  "word-frequency": [[[], {}], [["a", "b", "a"], { a: 2, b: 1 }], [["z", "z", "z"], { z: 3 }], [["constructor", "tostring", "constructor"], { constructor: 2, tostring: 1 }]],
};

export function problemCatalog(): Problem[] { return definitions.map(problem => ({ ...problem })); }
export function hiddenTests(id: ProblemId): HiddenTest[] {
  if (!Object.hasOwn(tests, id)) throw new Error("UNKNOWN_PROBLEM");
  return tests[id].map(([input, expected]) => ({ input: JSON.stringify(input) + "\n", expected }));
}
export function isProblemId(value: unknown): value is ProblemId {
  return definitions.some(problem => problem.id === value);
}
