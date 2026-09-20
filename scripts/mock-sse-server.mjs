/**
 * mock-sse-server.mjs — PoC 3 本地 mock：OpenAI 兼容 chat/completions（SSE 流式）。
 *
 * 宿主机运行：node scripts/mock-sse-server.mjs（默认 127.0.0.1:8787）
 * 模拟器访问：App 内请求 http://10.0.2.2:8787/v1（10.0.2.2 = 模拟器到宿主 loopback 别名）
 * 纯 node:http 零依赖；stream:true 逐块推 SSE（30 块 × ~60ms），否则返回完整 JSON。
 *
 * M3 冒烟增强：请求带 tools 且消息历史只有 1 条（agentic 首轮）时，返回一个
 * save_memory 工具调用——App 会执行工具并把结果回填发起第二轮，mock 对后续轮
 * 返回正文，从而完整验证 runAgentLoop 的 tool_calls 回填链路与 save_memory 落库。
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
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {}
    const stream = parsed.stream === true;
    console.log(`[${new Date().toISOString()}] POST ${req.url} stream=${stream} msgs=${parsed.messages?.length ?? 0}`);

    // agentic 首轮（带 tools 且只有系统段/首条消息）→ 下发一次 save_memory 工具调用
    const userMsgs = (parsed.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant');
    if (!stream && Array.isArray(parsed.tools) && parsed.tools.length > 0 && userMsgs.length === 1) {
      console.log('  -> mock issue save_memory tool_call (agent loop drill)');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock-tool',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'mock-call-1',
                    type: 'function',
                    function: {
                      name: 'save_memory',
                      arguments: JSON.stringify({ content: '冒烟测试记忆：由 mock 服务写入', category: 'general' }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
      return;
    }

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
    res.flushHeaders();
    // 按 4 字一段切块推送，模拟真实 token 流
    const chunkSize = 4;
    const pieces = REPLY.match(new RegExp(`.{1,${chunkSize}}`, 'gu')) ?? [];
    let i = 0;
    const timer = setInterval(() => {
      if (i >= pieces.length) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
        console.log(`[${new Date().toISOString()}] stream completed: ${i} chunks`);
        return;
      }
      const payload = JSON.stringify({
        id: 'mock-1',
        choices: [{ index: 0, delta: { content: pieces[i] } }],
      });
      res.write(`data: ${payload}\n\n`);
      i++;
    }, 30);
    // 注意挂 res 而不是 req：现代 Node 中 req 的 'close' 在请求体读完后立刻触发，
    // 挂 req 会瞬间清掉 interval 导致一个字节都发不出去
    res.on('close', () => {
      if (i < pieces.length) console.log(`[${new Date().toISOString()}] client closed early at chunk ${i}/${pieces.length}`);
      clearInterval(timer);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock SSE server: http://127.0.0.1:${PORT}/v1/chat/completions`);
});
