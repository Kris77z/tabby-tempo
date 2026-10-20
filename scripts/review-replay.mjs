import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = text => createHash('sha256').update(text).digest('base64');
const html = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const embedded = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** A portable, inert evidence viewer. No wallet, execution endpoint or remote resource is included. */
export async function renderReviewReplay(manifest, { generatedAt = new Date().toISOString() } = {}) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.claims) || !Array.isArray(manifest.sources) || !Array.isArray(manifest.timeline)) throw Error('REPLAY_MANIFEST_INVALID');
  const [css, client] = await Promise.all(['style.css', 'client.js'].map(file => readFile(new URL(`./review-replay/${file}`, import.meta.url), 'utf8')));
  const data = embedded({ manifest, generatedAt });
  const csp = `default-src 'none'; script-src 'sha256-${digest(client)}' 'sha256-${digest(data)}'; style-src 'sha256-${digest(css)}'; connect-src 'none'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`;
  return { csp, document: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${html(csp)}"><title>Tabby · 经营证据回放</title><style>${css}</style></head>
<body><header class="masthead"><a class="brand" href="#main"><span class="brand-mark" aria-hidden="true">t</span>tabby<span class="brand-caption">EVIDENCE / 经营证据</span></a><span class="read-only"><span aria-hidden="true">●</span> 离线只读回放</span></header>
<main id="main"><section class="intro"><div><p class="eyebrow">AGENT ECONOMY · REVIEW DESK</p><h1>沿着证据，复验一次经营过程。</h1><p class="lead">查看已核对的资金变化、任务结果与下一次选择。每个场景保留自己的环境、原始记录和验证边界。</p></div><aside class="scope-note"><strong>这里展示什么？</strong><p>保存证据的离线回放。本页不会发起交易、调用模型或连接钱包，也不证明生产服务当前在线。</p><p>不同场景独立展示，不拼接成一次连续的生产运行。</p></aside></section>
<section id="metrics" class="metrics" aria-label="证据概览"></section>
<section class="workspace" aria-label="证据浏览"><aside class="catalog"><div class="catalog-heading"><h2>选择一个场景</h2><span id="result-count" class="count" aria-live="polite"></span></div><label class="field">搜索能力或报告<input id="search" type="search" placeholder="例如：退款、策略、经营" autocomplete="off"></label><label class="field">证据环境<select id="environment"><option value="all">全部环境</option><option value="local">本地 Anvil · 受控环境</option><option value="offline">离线演示 · 合成记录</option></select></label><label class="toggle"><input id="include-earlier" type="checkbox"> 显示保留的早期版本</label><nav id="claim-list" aria-label="可复验场景"></nav></aside>
<article id="detail" class="detail" aria-live="polite" aria-atomic="false"><noscript>请启用 JavaScript 查看内嵌证据。此文件不需要网络连接。</noscript></article></section>
<footer><span>本地31337合成结算资产按USDC六位展示，不是公共Tempo账目。结算贡献未扣链费，实际净利润未知。</span><span id="export-time"></span></footer></main>
<script id="evidence-data" type="application/json">${data}</script><script>${client}</script></body></html>` };
}

export function createReplayServer(rendered) {
  return createServer((request, response) => {
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': rendered.csp, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { ...headers, allow: 'GET, HEAD' }); response.end('Read-only viewer'); return; }
    if (request.url !== '/') { response.writeHead(404, headers); response.end('Not found'); return; }
    response.writeHead(200, headers); response.end(request.method === 'HEAD' ? undefined : rendered.document);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log('Usage: npm run review:replay -- [--serve | --output /absolute/new-report.html]\nDefault: serve the checked, embedded report on a random 127.0.0.1 port. Ctrl+C stops the viewer.\n--output creates one standalone HTML file exclusively; it never overwrites evidence.'); return; }
  const output = args.length === 2 && args[0] === '--output' && isAbsolute(args[1]) ? args[1] : undefined;
  if (!output && args.length && !(args.length === 1 && args[0] === '--serve')) throw Error('REPLAY_USAGE_INVALID');
  const { buildReviewEvidence } = await import('./review-evidence.mjs');
  const rendered = await renderReviewReplay(await buildReviewEvidence());
  if (output) {
    const file = await open(output, 'wx', 0o600);
    try { await file.writeFile(rendered.document); } finally { await file.close(); }
    console.log(`Checked evidence replay saved: ${output}`); return;
  }
  const server = createReplayServer(rendered);
  await new Promise((resolve, reject) => { server.once('error', () => reject(Error('REPLAY_SERVER_FAILED'))); server.listen(0, '127.0.0.1', resolve); });
  console.log(`Checked evidence replay: http://127.0.0.1:${server.address().port}/\nRead-only local viewer. No wallet, model or production connection. Ctrl+C to stop.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error?.code === 'EEXIST' ? 'REPLAY_OUTPUT_EXISTS' : /^REPLAY_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'REPLAY_BUILD_FAILED'); process.exitCode = 1; });
