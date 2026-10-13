export { ArenaController, type Acceptance, type TestResult } from "./controller.js";
export { problemCatalog, type Problem, type ProblemId } from "./problems.js";
export { loadArenaConfig, parseConfig, type ArenaConfig, type TaskBinding, type Verdict, type Settlement } from "./protocol.js";
export { readControllerToken, requestSettlement } from "./ipc.js";
export { createArenaHttpServer, type RunStatus } from "./http.js";
export { submissionTypedData, SUBMISSION_TYPES, type Submission } from "./submission-auth.js";
