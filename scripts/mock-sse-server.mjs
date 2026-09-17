/**
 * mock-sse-server.mjs — PoC 3 本地 mock：OpenAI 兼容 chat/completions（SSE 流式）。
 *
 * 宿主机运行：node scripts/mock-sse-server.mjs（默认 127.0.0.1:8787）
 * 模拟器访问：adb reverse tcp:8787 tcp:8787 后，App 内请求 http://127.0.0.1:8787/v1
 * 纯 node:http 零依赖；stream:true 逐块推 SSE（30 块 × ~60ms），否则返回完整 JSON。
 */
import http from 'node:http';

const PORT = 8787;
const REPLY =
  'NP（Normalized Power，标准化功率）是 Coggan 功率体系的核心指标：' +
  '把逐秒功率先做 30 秒滚动平均、再取四次方均值后开四次方根，' +
  '用以反映变强度骑行的真实生理负荷，比平均功率更能刻画疲劳代价。'.repeat(2);

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let stream = false;
    try {
      stream = JSON.parse(body).stream === true;
    } catch {}
    console.log(`[${new Date().toISOString()}] POST ${req.url} stream=${stream}`);

    if (!stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock-1',
          choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
        }),
      );
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // 按 4 字一段切块推送，模拟真实 token 流
    const chunkSize = 4;
    const pieces = REPLY.match(new RegExp(`.{1,${chunkSize}}`, 'u')) ?? [];
    let i = 0;
    const timer = setInterval(() => {
      if (i >= pieces.length) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const payload = JSON.stringify({
        id: 'mock-1',
        choices: [{ index: 0, delta: { content: pieces[i] } }],
      });
      res.write(`data: ${payload}\n\n`);
      i++;
    }, 30);
    req.on('close', () => clearInterval(timer));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock SSE server: http://127.0.0.1:${PORT}/v1/chat/completions`);
});
