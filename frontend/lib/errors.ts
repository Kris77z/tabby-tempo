import { Interface } from "ethers";
import { ACCOUNT_ABI, ESCROW_ABI, MANAGER_ABI } from "./abi";
const decoder = new Interface([...ACCOUNT_ABI, ...ESCROW_ABI, ...MANAGER_ABI]);
export const SPEND_REASONS: Record<number, string> = {
  1: "目标 Provider 未加入白名单，资金无法转出。",
  2: "支付超过单笔、当日、授信或协议全局限额。",
  3: "Agent 已冻结，当前 SpendPolicy 拒绝支出。",
  4: "信用授权无效或缺失，无法支付 cash 之外的部分。",
  5: "授权与当前 Agent 不一致。",
};
const REASONS: Record<string, string> = {
  IdentityChanged: "ERC-8004 身份已变更，旧授信被冻结；需 Guardian 重新批准。",
  IdentityVersionMismatch: "身份版本与授信快照不一致。",
  AgentIsFrozen: "协议已冻结该 Agent。", DrawPaused: "协议暂停新增提款。",
  NotAgentWallet: "请连接当前 Agent 的 registry wallet。",
  NotAgentOwner: "请连接当前 Agent 的 registry owner。",
  BadSignature: "Underwriter 签名无效。", AuthExpired: "授信已过期，请重新获取。",
  NonceAlreadyUsed: "授信 nonce 已使用。", TaskNotAssigned: "任务尚未分配。",
  TaskDeadlinePassed: "任务期限已到。", LoanAlreadyExists: "任务已有借款记录。",
  DeadlineInPast: "任务期限必须晚于当前时间。",
  InvalidTaskStatus: "任务状态不允许此操作。", InsufficientLiquidity: "协议资金池余额不足。",
};
function revertData(error: unknown, depth = 0): string | undefined {
  if (depth > 6) return;
  if (typeof error === "string") {
    if (/^0x[\da-f]{8,}$/i.test(error)) return error;
    if (error.startsWith("{")) { try { return revertData(JSON.parse(error), depth + 1); } catch { return; } }
  }
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    for (const key of ["data", "error", "originalError", "info", "cause", "body", "result"]) {
      const found = revertData(obj[key], depth + 1);
      if (found) return found;
    }
  }
}
export function explainError(error: unknown): { code: string; message: string; detail?: string } {
  const data = revertData(error);
  if (data) {
    try {
      const parsed = decoder.parseError(data);
      if (parsed) {
        if (parsed.name === "SpendRejected") return {
          code: "SpendRejected", message: SPEND_REASONS[Number(parsed.args.reason)] ?? "SpendPolicy 拒绝支出。",
          detail: `Agent #${parsed.args.agentId} · target ${parsed.args.target} · reason ${parsed.args.reason}`,
        };
        return { code: parsed.name, message: REASONS[parsed.name] ?? `链上拒绝：${parsed.name}`, detail: parsed.args.map(String).join(" · ") };
      }
    } catch { /* malformed or unrelated revert */ }
  }
  const obj = error && typeof error === "object" ? error as Record<string, unknown> : {};
  if (obj.code === "SpendRejected") {
    const reason = Number(obj.reason ?? String(obj.message).match(/reason\s+(\d+)/)?.[1]);
    return { code: "SpendRejected", message: SPEND_REASONS[reason] ?? String(obj.message || "SpendPolicy 拒绝支出。") };
  }
  if (typeof obj.code === "string" && REASONS[obj.code]) return { code: obj.code, message: REASONS[obj.code] };
  if (obj.code === 4001 || obj.code === "ACTION_REJECTED") return { code: "ACTION_REJECTED", message: "钱包签名已取消。" };
  return { code: typeof obj.code === "string" ? obj.code : "REQUEST_FAILED", message: error instanceof Error ? error.message : "请求失败，请刷新后重试。" };
}
