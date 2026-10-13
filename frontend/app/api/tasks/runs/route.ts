import "server-only";
import { taskRunsRequest } from "../../../../lib/task-runner-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) { return taskRunsRequest(request, { upstreamUrl: process.env.TASK_RUNNER_URL }); }
export async function POST(request: Request) { return taskRunsRequest(request, { upstreamUrl: process.env.TASK_RUNNER_URL }); }
