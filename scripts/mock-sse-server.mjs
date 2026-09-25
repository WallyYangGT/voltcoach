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
 *
 * 故障注入（2026-09-22 真机 JSON 解析事故的复现开关）：
 *   MOCK_FAIL_EMPTY=N —— 前 N 次"正文请求"（不含 tool_call 演练轮）返回 200 + 空正文；
 *   真机上 Hermes 在 res.json() 里抛的正是 JSON Parse error: Unexpected end of input。
 *   用于演练传输层自动重试（首轮空 → 自动补发 → 成功）。
 *   MOCK_TRUNCATE=N   —— 前 N 次正文请求的非流式正文**截半**下发（真机"正文被中间层
 *   掐断"的形态，报「AI 响应不是完整 JSON」）；与 MOCK_FAIL_EMPTY 独立计数。
 *   MOCK_CUT_AFTER=N  —— 流式请求推 N 帧后 `res.destroy()` 掐断连接（演练"已吐字的流
 *   不重试"与读取中断归传输级）。
 *   MOCK_DELAY_MS=N   —— 正文请求前等待 N 毫秒，模拟长报告（观察"生成中"状态与已等待时长）。
 *   MOCK_TOOL_SCRIPT=ftp —— M5 FTP 剧本：estimate_ftp → update_ftp → reanalyze_activity
 *   （目标文件用 MOCK_REANALYZE_FILE=<file_name> 指定）三轮工具后回正文，
 *   用于「AI 更新 FTP + 重新分析」端到端冒烟。
 */
import http from 'node:http';

const PORT = 8787;
const REPLY =
  'NP（Normalized Power，标准化功率）是 Coggan 功率体系的核心指标：' +
  '把逐秒功率先做 30 秒滚动平均、再取四次方均值后开四次方根，' +
  '用以反映变强度骑行的真实生理负荷，比平均功率更能刻画疲劳代价。'.repeat(2);

const FAIL_EMPTY = Number(process.env.MOCK_FAIL_EMPTY || 0); // 前 N 次正文请求注入空正文
const TRUNCATE = Number(process.env.MOCK_TRUNCATE || 0); // 前 N 次正文请求注入截半正文
const CUT_AFTER = Number(process.env.MOCK_CUT_AFTER || 0); // 流式推 N 帧后掐断连接
const DELAY_MS = Number(process.env.MOCK_DELAY_MS || 0); // 正文请求前的模拟等待
// MOCK_TOOL_SCRIPT=ftp —— M5 FTP 剧本：按历史中 tool 消息数推进
// estimate_ftp → update_ftp → reanalyze_activity（MOCK_REANALYZE_FILE 指定文件名），
// 三轮后回正文。用于「AI 更新 FTP + 重新分析」端到端冒烟。
const TOOL_SCRIPT = process.env.MOCK_TOOL_SCRIPT || '';
const REANALYZE_FILE = process.env.MOCK_REANALYZE_FILE || '';
const FTP_REPLY =
  '已检查你的 FTP 数据：窗口内骑行功率-心率交叉验证通过，' +
  'FTP 已按当前最佳估算更新，并已对目标训练按新参数重新分析，TSS 与区间分布已对齐。';
let contentCalls = 0; // 正文请求计数（tool_call 演练轮不计入）

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

    // FTP 剧本（MOCK_TOOL_SCRIPT=ftp）：按历史中 role:"tool" 消息数确定轮次
    if (!stream && TOOL_SCRIPT === 'ftp' && Array.isArray(parsed.tools) && parsed.tools.length > 0) {
      const toolMsgCount = (parsed.messages ?? []).filter((m) => m.role === 'tool').length;
      const plan = [
        { name: 'estimate_ftp', args: {} },
        { name: 'update_ftp', args: {} },
        { name: 'reanalyze_activity', args: { file_name: REANALYZE_FILE } },
      ];
      if (toolMsgCount < plan.length) {
        const step = plan[toolMsgCount];
        console.log(`  -> mock script ftp: issue ${step.name} (round ${toolMsgCount + 1})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `mock-ftp-${toolMsgCount}`,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: `mock-ftp-call-${toolMsgCount}`,
                      type: 'function',
                      function: { name: step.name, arguments: JSON.stringify(step.args) },
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
      // 三轮工具用尽 → 落到下方正文回复（FTP_REPLY）
      console.log('  -> mock script ftp: final reply');
      contentCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock-ftp-final',
          choices: [{ index: 0, message: { role: 'assistant', content: FTP_REPLY }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
        }),
      );
      return;
    }

    // 故障注入：前 N 次正文请求返回 200 + 空正文（真机上即 JSON Parse error 现场）
    contentCalls += 1;
    if (contentCalls <= FAIL_EMPTY) {
      console.log(`  -> fault injected: empty 200 body (#${contentCalls}, transport retry drill)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('');
      return;
    }
    const respond = () => {
      if (!stream) {
        const full = JSON.stringify({
          id: 'mock-1',
          choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
        });
        // 截半下发：真机"正文被中间层掐断"的形态（客户端报「不是完整 JSON」）
        const cut = contentCalls <= TRUNCATE;
        if (cut) console.log(`  -> fault injected: truncated body (#${contentCalls}, bad-json drill)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(cut ? full.slice(0, Math.floor(full.length / 2)) : full);
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
        if (CUT_AFTER > 0 && i >= CUT_AFTER) {
          // 推 N 帧后掐断连接：客户端应归为读取中断传输级错误（已吐字则不重试）
          clearInterval(timer);
          console.log(`[${new Date().toISOString()}] socket destroyed after ${i} chunks (cut drill)`);
          res.destroy();
          return;
        }
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
    };

    if (DELAY_MS > 0) {
      console.log(`  -> simulating long report: wait ${DELAY_MS}ms`);
      setTimeout(respond, DELAY_MS);
    } else {
      respond();
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock SSE server: http://127.0.0.1:${PORT}/v1/chat/completions`);
});
