/**
 * ai.test.mjs — src/ai 请求层与 agent 循环回归测试。
 * 自 reference/test/ai.test.mjs 同源搬运（真实 mock 服务换 mock fetch 注入——
 * App 内传输层为 expo/fetch，其流式读取已由 M0 PoC 3 验证，这里守住解析与循环逻辑）：
 * 非流式/流式拼接/HTTP 错误透出/总超时、tool_calls 回填、bestContent 最长正文、
 * 轮数耗尽强制作答、400 降级、executeTool 异常兜 {error}。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { requestChatCompletion } = await import('../src/ai/http.ts');
const { callAI, runAgentLoop } = await import('../src/ai/agent.ts');
const { AGENTIC } = await import('../src/core/settings.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 运行时配置（指向 mock fetch） */
const CFG = {
  base_url: 'http://mock.local/v1',
  api_key: 'test-key',
  model: 'test-model',
  temperature: null,
  timeout_ms: 600000,
  stall_ms: 60000,
  stream: false,
};

/** 构造非流式 JSON 响应的 mock fetch：handler 按调用序号返回 {status, body, delay, capture} */
function jsonFetch(handler) {
  const seen = [];
  const impl = async (url, init) => {
    const idx = seen.length;
    seen.push({ url, body: JSON.parse(init.body), init });
    const h = typeof handler === 'function' ? handler(JSON.parse(init.body), idx) : handler;
    const { status = 200, body, delay = 0 } = h;
    await sleep(delay);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  impl.seen = seen;
  return impl;
}

/** SSE 流式响应的 mock fetch：chunks 逐块下发（字符串 → 按 UTF-8 字节切分可选） */
function sseFetch(chunks, { splitBytes = false } = {}) {
  const seen = [];
  const enc = new TextEncoder();
  const impl = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    const stream = new ReadableStream({
      async start(controller) {
        for (const c of chunks) {
          const bytes = enc.encode(c);
          if (splitBytes && bytes.length > 3) {
            // 把一个 data 行从中间字节处拆成两块（多字节字符跨块，考验解码器）
            controller.enqueue(bytes.slice(0, 3));
            controller.enqueue(bytes.slice(3));
          } else {
            controller.enqueue(bytes);
          }
          await sleep(10);
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };
  impl.seen = seen;
  return impl;
}

/** 永不响应的 mock fetch（signal abort 时 reject，供总超时测试） */
function hangFetch() {
  return async (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
}

const msg = (content, extra = {}) => ({ status: 200, body: { choices: [{ message: { content, ...extra } }] } });

// ---------------- requestChatCompletion / callAI ----------------

test('callAI: 非流式返回完整正文，请求头与请求体口径正确', async () => {
  const f = jsonFetch(() => msg('复盘报告正文'));
  const text = await callAI(f, CFG, '提示词', { timeoutMs: 5000 });
  assert.equal(text, '复盘报告正文');
  assert.equal(f.seen[0].url, 'http://mock.local/v1/chat/completions');
  assert.equal(f.seen[0].init.headers.Authorization, 'Bearer test-key');
  assert.equal(f.seen[0].body.stream, false);
  assert.equal(f.seen[0].body.model, 'test-model');
  assert.deepEqual(f.seen[0].body.messages, [{ role: 'user', content: '提示词' }]);
  assert.equal('temperature' in f.seen[0].body, false); // temperature=null 时不传
});

test('callAI: messages 数组直接透传（追问多轮）+ temperature 按配置携带', async () => {
  const f = jsonFetch(() => msg('回答'));
  const messages = [
    { role: 'user', content: '系统段' },
    { role: 'user', content: '上一问' },
    { role: 'assistant', content: '上一答' },
    { role: 'user', content: '追问' },
  ];
  await callAI(f, { ...CFG, temperature: 0.7 }, messages, { timeoutMs: 5000 });
  assert.deepEqual(f.seen[0].body.messages, messages);
  assert.equal(f.seen[0].body.temperature, 0.7);
});

test('callAI: 流式 SSE 逐 chunk 拼接 + 回调顺序一致', async () => {
  const f = sseFetch([
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '你好' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '，世界' } }] }) + '\n\n',
    'data: [DONE]\n\n',
  ]);
  const deltas = [];
  const text = await callAI(f, { ...CFG, stream: true }, '提示词', { timeoutMs: 5000, onChunk: (d) => deltas.push(d) });
  assert.equal(text, '你好，世界');
  assert.deepEqual(deltas, ['你好', '，世界']);
  assert.equal(f.seen[0].body.stream, true);
});

test('callAI: SSE 多字节字符跨块断开仍正确解码（字节级切行）', async () => {
  const line = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '中文混合Power⚡' } }] }) + '\n\n';
  const f = sseFetch([line, 'data: [DONE]\n\n'], { splitBytes: true });
  const text = await callAI(f, { ...CFG, stream: true }, '提示词', { timeoutMs: 5000 });
  assert.equal(text, '中文混合Power⚡');
});

test('callAI: HTTP 错误状态透出状态码（含 agent 降级所需的格式）', async () => {
  const f = jsonFetch(() => ({ status: 429, body: 'rate limited' }));
  await assert.rejects(callAI(f, CFG, '提示词', { timeoutMs: 5000 }), /AI API 返回 429: rate limited/);
});

test('callAI: 超过 timeoutMs 总时限报超时错误（双语消息）', async () => {
  const f = hangFetch();
  await assert.rejects(callAI(f, CFG, '提示词', { timeoutMs: 200 }), /AI 请求总时间超过 0\.2 秒/);
  await assert.rejects(callAI(f, CFG, '提示词', { timeoutMs: 200, lang: 'en' }), /exceeded 0\.2 seconds/);
});

test('callAI: 未配置密钥时直接报 no_key', async () => {
  await assert.rejects(callAI(jsonFetch(() => msg('x')), { ...CFG, api_key: '' }, '提示词'), /未配置 AI 密钥/);
});

test('runAgentLoop 与 callAI 共用 requestChatCompletion：tool_calls 消息正常解析', async () => {
  const body = { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] } }] };
  const result = await requestChatCompletion(jsonFetch(() => ({ status: 200, body })), 'http://m/v1', 'k', {});
  assert.equal(result.tool_calls.length, 1); // 不算空响应
});

// ---------------- runAgentLoop（agentic function calling） ----------------

const FAKE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_form_series',
      description: '取逐日状态',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const toolCallMsg = (name, args, id = 'call_1') => ({
  status: 200,
  body: { choices: [{ message: { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] },
});

test('runAgentLoop: 首轮 tool_calls → 执行回填 → 次轮返回正文', async () => {
  const f = jsonFetch((body, idx) => (idx === 0 ? toolCallMsg('get_form_series', { days: 14 }) : msg('最终回答')));
  const executed = [];
  const logged = [];
  const text = await runAgentLoop(
    f, CFG,
    [{ role: 'user', content: '这周状态如何？' }],
    FAKE_TOOLS,
    async (name, args) => {
      executed.push([name, args]);
      return JSON.stringify({ series: [1, 2, 3] });
    },
    { timeoutMs: 5000, onToolCall: (n, a, r) => logged.push([n, a, r]) },
  );
  assert.equal(text, '最终回答');
  // 首轮请求带 tools 定义与 tool_choice，全轮非流式
  assert.deepEqual(f.seen[0].body.tools, FAKE_TOOLS);
  assert.equal(f.seen[0].body.tool_choice, 'auto');
  assert.equal(f.seen[0].body.stream, false);
  // executeTool 收到解析后的参数，onToolCall 拿到结果
  assert.deepEqual(executed, [['get_form_series', { days: 14 }]]);
  assert.equal(logged.length, 1);
  // 次轮请求：assistant（含 tool_calls）+ role:"tool" 结果回填
  const msgs = f.seen[1].body.messages;
  assert.equal(msgs.at(-2).role, 'assistant');
  assert.equal(msgs.at(-2).tool_calls[0].function.name, 'get_form_series');
  assert.equal(msgs.at(-1).role, 'tool');
  assert.equal(msgs.at(-1).tool_call_id, 'call_1');
  assert.equal(msgs.at(-1).content, JSON.stringify({ series: [1, 2, 3] }));
});

test('runAgentLoop: 中间轮写了长报告、末轮只剩收尾片段时返回最长正文', async () => {
  // 复现线上问题：模型把完整报告写在带 tool_calls 的中间轮，
  // 最后一轮只回"分析已完成，如需……"式片段——应以最长正文为准
  const longReport = '# 训练复盘报告\n\n' + '详细分析内容。'.repeat(50);
  const wrapUp = '以上分析已完成。如需进一步帮助请告诉我。';
  const f = jsonFetch((_body, idx) => {
    if (idx === 0) return toolCallMsg('get_form_series', { days: 14 });
    if (idx === 1)
      return {
        status: 200,
        body: {
          choices: [{
            message: {
              content: longReport, // 长报告与 tool_calls 同轮出现
              tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'get_form_series', arguments: '{}' } }],
            },
          }],
        },
      };
    return msg(wrapUp);
  });
  const text = await runAgentLoop(f, CFG, [{ role: 'user', content: '复盘' }], FAKE_TOOLS, async () => '{}', { timeoutMs: 5000 });
  assert.equal(text, longReport);
  assert.equal(f.seen.length, 3);
});

test('runAgentLoop: 轮数耗尽后去掉 tools 强制直接作答', async () => {
  const f = jsonFetch((body, idx) =>
    Array.isArray(body.tools) ? toolCallMsg('get_form_series', {}, `call_${idx}`) : msg('被迫作答'),
  );
  let execCount = 0;
  const text = await runAgentLoop(f, CFG, [{ role: 'user', content: '问' }], FAKE_TOOLS, async () => { execCount++; return '{}'; }, { timeoutMs: 10000 });
  assert.equal(text, '被迫作答');
  assert.equal(execCount, AGENTIC.max_rounds); // 每轮一次工具调用
  // 共 max_rounds 轮带 tools + 最后一轮不带 tools
  assert.equal(f.seen.length, AGENTIC.max_rounds + 1);
  const last = f.seen.at(-1);
  assert.equal('tools' in last.body, false);
  assert.match(last.body.messages.at(-1).content, /直接作答/);
});

test('runAgentLoop: 模型不支持 tools（首轮 400）自动降级单轮', async () => {
  const f = jsonFetch((body) => {
    if (Array.isArray(body.tools)) return { status: 400, body: JSON.stringify({ error: { message: 'tools not supported' } }) };
    return msg('降级回答');
  });
  let degraded = null;
  const text = await runAgentLoop(f, CFG, [{ role: 'user', content: '问' }], FAKE_TOOLS, async () => '{}', {
    timeoutMs: 5000,
    onDegrade: (m) => (degraded = m),
  });
  assert.equal(text, '降级回答');
  assert.match(degraded, /400/);
  assert.equal(f.seen.length, 2); // 带 tools 失败一次 + 无 tools 重发一次
});

test('runAgentLoop: tools 为空数组时不挂 tools 单轮（agentic 总开关关闭的编排形态）', async () => {
  const f = jsonFetch(() => msg('单轮回答'));
  const text = await runAgentLoop(f, CFG, [{ role: 'user', content: '问' }], [], async () => '{}', { timeoutMs: 5000 });
  assert.equal(text, '单轮回答');
  assert.equal(f.seen.length, 1);
  assert.equal('tools' in f.seen[0].body, false);
});

test('runAgentLoop: executeTool 抛异常转为 {error} 回填，循环不中断', async () => {
  const f = jsonFetch((_b, idx) => (idx === 0 ? toolCallMsg('get_form_series', {}) : msg('带错作答')));
  const text = await runAgentLoop(f, CFG, [{ role: 'user', content: '问' }], FAKE_TOOLS, async () => { throw new Error('db 炸了'); }, { timeoutMs: 5000 });
  assert.equal(text, '带错作答');
  const toolMsg = f.seen[1].body.messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.match(toolMsg.content, /"error"/);
  assert.match(toolMsg.content, /db 炸了/);
});

test('runAgentLoop: tool arguments 非法 JSON 按空参数处理', async () => {
  const f = jsonFetch((_b, idx) =>
    idx === 0
      ? { status: 200, body: { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{bad json' } }] } }] } }
      : msg('ok'),
  );
  const seen = [];
  await runAgentLoop(f, CFG, [{ role: 'user', content: '问' }], FAKE_TOOLS, async (_n, args) => { seen.push(args); return '{}'; }, { timeoutMs: 5000 });
  assert.deepEqual(seen[0], {});
});
