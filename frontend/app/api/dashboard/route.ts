import { dashboard } from "../../../lib/dashboard";
export const dynamic = "force-dynamic";
export async function GET() {
  try { const value = await dashboard(); return Response.json(value, { status: value.readStatus === "unavailable" ? 503 : 200, headers: { "Cache-Control": "no-store" } }); }
  catch {
    // Never send provider internals, RPC credentials or stack traces into the browser.
    return Response.json({ error: "READ_FAILED", message: "链上读取暂时失败，请检查部署清单、RPC 与 Underwriter 服务。" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
