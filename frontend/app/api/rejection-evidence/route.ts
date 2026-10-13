import "server-only";
import { loadDeployment } from "../../../lib/config";
import { readRejectionEvidence } from "../../../lib/rejection-evidence";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function GET() {
  const statePath = process.env.FRONTEND_DEMO_STATE_PATH;
  if (!statePath || process.env.FRONTEND_MODE === "fixture") return Response.json({ verified: false,
    code: "REJECTION_EVIDENCE_NOT_CONFIGURED", message: "未配置本次真实拒绝交易证据。" }, { status: 404, headers });
  try {
    const config = await loadDeployment();
    if (!config) throw new Error("MANIFEST_MISSING");
    return Response.json(await readRejectionEvidence(config, statePath), { headers });
  } catch {
    return Response.json({ verified: false, code: "REJECTION_EVIDENCE_UNVERIFIABLE",
      message: "历史拒绝证据不可验证，请检查本次清单、记录与链上回执。" }, { status: 503, headers });
  }
}
