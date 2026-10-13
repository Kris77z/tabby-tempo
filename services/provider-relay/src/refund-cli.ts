// Explicit local operation. Does not read any .env file itself; use Node --env-file.
const [paymentId, refundId, amount] = process.argv.slice(2);
if (!paymentId || !refundId || !amount || !process.env.OPERATOR_TOKEN) throw new Error("Usage: refund-cli.ts paymentId refundId decimalAmount; set OPERATOR_TOKEN");
const url = new URL(process.env.RELAY_URL || "http://127.0.0.1:8788");
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Operator CLI requires loopback relay URL");
url.pathname = "/ops/refund";
const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPERATOR_TOKEN}` },
  body: JSON.stringify({ paymentId, refundId, amount }) });
console.log(JSON.stringify(await response.json()));
if (!response.ok) process.exitCode = 1;
