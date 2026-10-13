import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { monadProvider } from '../demo-rpc.js';

test('opt-in direct RPC retries only reads and paces concurrent requests without replaying writes', async () => {
  const oldInterval = process.env.AGENTFUEL_RPC_INTERVAL_MS, oldRetry = process.env.AGENTFUEL_RPC_RETRY_READ_503;
  process.env.AGENTFUEL_RPC_INTERVAL_MS = '40'; process.env.AGENTFUEL_RPC_RETRY_READ_503 = '1';
  const calls: { method: string; at: number }[] = []; let failedRead = false;
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); calls.push({ method: body.method, at: Date.now() });
    if ((body.method === 'eth_blockNumber' && !failedRead) || body.method === 'eth_sendRawTransaction') {
      failedRead = true; res.writeHead(503); res.end('temporarily unavailable'); return;
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x1' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  const connection = await monadProvider(`http://127.0.0.1:${address.port}`, 'direct');
  try {
    assert.equal(await connection.provider.send('eth_blockNumber', []), '0x1');
    assert.equal(calls.filter(x => x.method === 'eth_blockNumber').length, 2);
    calls.length = 0;
    await Promise.all([connection.provider.send('eth_chainId', []), connection.provider.send('eth_chainId', []), connection.provider.send('eth_chainId', [])]);
    assert.equal(calls.length, 3);
    assert.ok(calls[1].at - calls[0].at >= 30); assert.ok(calls[2].at - calls[1].at >= 30);
    await assert.rejects(connection.provider.send('eth_sendRawTransaction', ['0x00']));
    assert.equal(calls.filter(x => x.method === 'eth_sendRawTransaction').length, 1);
  } finally {
    connection.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (oldInterval === undefined) delete process.env.AGENTFUEL_RPC_INTERVAL_MS; else process.env.AGENTFUEL_RPC_INTERVAL_MS = oldInterval;
    if (oldRetry === undefined) delete process.env.AGENTFUEL_RPC_RETRY_READ_503; else process.env.AGENTFUEL_RPC_RETRY_READ_503 = oldRetry;
  }
});
