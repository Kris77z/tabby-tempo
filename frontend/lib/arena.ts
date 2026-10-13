export type ArenaCatalog = { problems: { id: string; prompt: string; reward: string; language: "python3" }[]; tasks: Record<string, { agentId: string; problemId: string }> };
export type ArenaRun = { runId: string; taskId: string; status: "running" | "settled" | "error";
  result?: { verdict: { passed: boolean; mode: "docker"; evidenceHash: string; chainId: string; escrowAddress: string; agentId: string; problemId: string };
    tests: { case: number; passed: boolean; failure?: string }[]; settlement: { txHash: string; blockNumber: number; passed: boolean; feedback?: { type: number; sent: boolean; pending: boolean }[] } }; error?: string };

export async function arenaRequest<T>(base: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  const response = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const result = await response.json();
  if (!response.ok) {
    if (result.error === "TASK_ALREADY_SUBMITTED" && result.runId) return { runId: result.runId, taskId: (body as { taskId: string }).taskId, status: "running" } as T;
    throw new Error(`Arena：${result.error || `HTTP ${response.status}`}`);
  }
  return result as T;
}
