/**
 * ai.test.mjs — src/ai 请求层与 agent 循环回归测试。
 * 自 fit-reader Web 版 test/ai.test.mjs 同源搬运（真实 mock 服务换 mock fetch 注入——
 * App 内传输层为 expo/fetch，其流式读取已由 M0 PoC 3 验证，这里守住解析与循环逻辑）：
 * 非流式/流式拼接/HTTP 错误透出/总超时、tool_calls 回填、bestContent 最长正文、
 * 轮数耗尽强制作答、400 降级、executeTool 异常兜 {error}。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { requestChatCompletion, AiTransportError, AiCancelledError } = await import('../src/ai/http.ts');
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

test('callAI: HTTP 错误透出状态码（消息格式 + httpStatus 类型化字段）', async () => {
  const f = jsonFetch(() => ({ status: 429, body: 'rate limited' }));
  await assert.rejects(callAI(f, CFG, '提示词', { timeoutMs: 5000 }), (e) => {
    assert.ok(e instanceof AiTransportError);
    assert.match(e.message, /AI API 返回 429: rate limited/);
    assert.equal(e.httpStatus, 429); // agent 循环的 tools 降级按该字段判定，不再解析消息文案
    return true;
  });
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

test('runAgentLoop: 模型不支持 tools（首轮 httpStatus=400）自动降级单轮', async () => {
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

// ---------------- http.ts 错误分支（code-review 后补齐覆盖） ----------------

const { requestChatCompletion: rcc } = await import('../src/ai/http.ts');

test('requestChatCompletion: 破损响应体给出可定位报错（自动重试后仍失败）', async () => {
  const f = async () => new Response('not-json{{', { status: 200 });
  await assert.rejects(
    rcc(f, 'http://m/v1', 'k', {}, { retryDelayMs: 1 }),
    /AI 响应不是完整 JSON（HTTP 200，收到 10 字符）：not-json\{\{/,
  );
});

test('requestChatCompletion: 空响应体（网关掐断的现场形态）自动重试一次即恢复', async () => {
  let calls = 0;
  const f = async () => {
    calls += 1;
    return calls === 1
      // 首次正文为空 —— 真机上 Hermes 在此抛 "JSON Parse error: Unexpected end of input"
      ? new Response('', { status: 200 })
      : new Response(JSON.stringify({ choices: [{ message: { content: '重试成功' } }] }), { status: 200 });
  };
  const retries = [];
  const res = await rcc(f, 'http://m/v1', 'k', {}, {
    retryDelayMs: 1,
    onRetry: (attempt, errMsg) => retries.push({ attempt, errMsg }),
  });
  assert.equal(calls, 2); // 已自动补发
  assert.equal(res.content, '重试成功');
  assert.deepEqual(retries.map((r) => r.attempt), [2]);
  assert.match(retries[0].errMsg, /AI 服务返回空响应（HTTP 200）/);
});

test('requestChatCompletion: 重试仍失败时消息标明已自动重试，且只重试一次', async () => {
  let calls = 0;
  const f = async () => {
    calls += 1;
    return new Response('', { status: 200 });
  };
  await assert.rejects(rcc(f, 'http://m/v1', 'k', {}, { retryDelayMs: 1 }), /已自动重试 1 次/);
  assert.equal(calls, 2); // 首次 + 1 次，封顶
});

test('requestChatCompletion: 400 属请求侧问题不重试（错误带 httpStatus 供 agent 降级判定）', async () => {
  let calls = 0;
  const f = async () => {
    calls += 1;
    return new Response('bad request', { status: 400 });
  };
  await assert.rejects(rcc(f, 'http://m/v1', 'k', {}, { retryDelayMs: 1 }), (e) => {
    assert.ok(e instanceof AiTransportError);
    assert.match(e.message, /AI API 返回 400: bad request/);
    assert.equal(e.httpStatus, 400);
    assert.equal(e.retryable, false);
    return true;
  });
  assert.equal(calls, 1);
});

test('requestChatCompletion: 5xx 属瞬时故障重试一次', async () => {
  let calls = 0;
  const f = async () => {
    calls += 1;
    return new Response('boom', { status: 503 });
  };
  await assert.rejects(rcc(f, 'http://m/v1', 'k', {}, { retryDelayMs: 1 }), /AI API 返回 503/);
  assert.equal(calls, 2);
});

test('requestChatCompletion: 正文读取中断报读取失败（非"解析失败"）并按传输级重试', async () => {
  let calls = 0;
  const f = async () => {
    calls += 1;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('socket hang up'));
        },
      }),
      { status: 200 },
    );
  };
  await assert.rejects(
    rcc(f, 'http://m/v1', 'k', {}, { retryDelayMs: 1 }),
    /AI 响应读取失败：socket hang up/,
  );
  assert.equal(calls, 2); // 断连属瞬时故障，重试一次
});

test('requestChatCompletion: 连接建立失败（fetch reject）归传输级并重试一次', async () => {
  let calls = 0;
  const f = async () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('fetch failed: fetch canceled');
      err.name = 'FetchError';
      throw err;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '连上了' } }] }), { status: 200 });
  };
  const res = await rcc(f, 'http://m/v1', 'k', {}, { retryDelayMs: 1 });
  assert.equal(calls, 2);
  assert.equal(res.content, '连上了');
});

test('requestChatCompletion: 无 tools 的请求重试时改走流式（长请求防网关空闲掐断）', async () => {
  const enc = new TextEncoder();
  const seenBodies = [];
  let calls = 0;
  const f = async (_url, init) => {
    calls += 1;
    seenBodies.push(JSON.parse(init.body));
    if (calls === 1) return new Response('', { status: 200 }); // 首次空正文
    // 重试改成流式请求：服务端按 SSE 吐字
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          enc.encode(
            'data: ' + JSON.stringify({ choices: [{ delta: { content: '流式重试成功' } }] }) + '\n\n',
          ),
        );
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };
  const res = await rcc(f, 'http://m/v1', 'k', { stream: false, messages: [] }, { retryDelayMs: 1 });
  assert.equal(seenBodies[0].stream, false); // 首次仍按调用方口径（非流式）
  assert.equal(seenBodies[1].stream, true); // 重试改流式
  assert.equal(res.content, '流式重试成功'); // 调用方没要增量 → 按 message 对象回
});

test('requestChatCompletion: 带 tools 的请求重试不改流式（tool_calls 增量帧不解析）', async () => {
  const seenBodies = [];
  let calls = 0;
  const f = async (_url, init) => {
    calls += 1;
    seenBodies.push(JSON.parse(init.body));
    if (calls === 1) return new Response('', { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '工具轮重试' } }] }), { status: 200 });
  };
  const body = { stream: false, messages: [], tools: [{ type: 'function', function: { name: 'x' } }] };
  const res = await rcc(f, 'http://m/v1', 'k', body, { retryDelayMs: 1 });
  assert.equal(seenBodies[0].stream, false);
  assert.equal(seenBodies[1].stream, false); // 保持非流式
  assert.equal(res.content, '工具轮重试');
});

test('requestChatCompletion: 流式「delta 帧 + 末尾整段 message 帧」不重复正文', async () => {
  // 部分网关在增量流末尾补一帧带 message 的收尾帧：无条件取 message.content 会让正文翻倍
  const f = sseFetch([
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '前半段' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ message: { content: '前半段后半段' } }] }) + '\n\n',
    'data: [DONE]\n\n',
  ]);
  const chunks = [];
  const text = await requestChatCompletion(f, 'http://m/v1', 'k', {}, {
    onStreamChunk: (d) => chunks.push(d),
  });
  assert.equal(text, '前半段');
  assert.deepEqual(chunks, ['前半段']);
});

test('requestChatCompletion: 流式请求收到整段 JSON（服务端无视 stream）按非流式解析', async () => {
  const f = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '整段正文' } }] }), { status: 200 });
  const chunks = [];
  const text = await requestChatCompletion(f, 'http://m/v1', 'k', {}, {
    onStreamChunk: (d) => chunks.push(d),
  });
  assert.equal(text, '整段正文');
  assert.deepEqual(chunks, ['整段正文']);
});

test('requestChatCompletion: 流式请求收到无正文的整段 JSON 视为空响应', async () => {
  const f = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: null } }] }), { status: 200 });
  await assert.rejects(
    requestChatCompletion(f, 'http://m/v1', 'k', {}, { onStreamChunk: () => {}, retryDelayMs: 1 }),
    /AI API 返回为空/,
  );
});

test('requestChatCompletion: 空 choices 视为空响应', async () => {
  const f = jsonFetch(() => ({ status: 200, body: { choices: [] } }));
  await assert.rejects(rcc(f, 'http://m/v1', 'k', {}), /AI API 返回为空/);
});

test('requestChatCompletion: SSE data 行为坏 JSON 时抛错并 cancel 流', async () => {
  const f = sseFetch(['data: {broken json\n\n']);
  await assert.rejects(
    requestChatCompletion(f, 'http://m/v1', 'k', {}, { onStreamChunk: () => {}, retryDelayMs: 1 }),
    /AI 流式帧被截断/,
  );
});

test('requestChatCompletion: 流式已吐字后帧截断不重试（避免正文重复）', async () => {
  const good = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '前文' } }] }) + '\n\n';
  const f = sseFetch([good, 'data: {broken json\n\n']);
  const chunks = [];
  await assert.rejects(
    requestChatCompletion(f, 'http://m/v1', 'k', {}, {
      onStreamChunk: (d) => chunks.push(d),
      retryDelayMs: 1,
    }),
    /AI 流式帧被截断/,
  );
  assert.deepEqual(chunks, ['前文']);
  assert.equal(f.seen.length, 1); // 已吐字的流不重发
});

test('requestChatCompletion: 空 data 帧（网关心跳）按忽略处理不报错', async () => {
  const f = sseFetch([
    'data:\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '正文' } }] }) + '\n\n',
    'data: [DONE]\n\n',
  ]);
  const text = await requestChatCompletion(f, 'http://m/v1', 'k', {}, { onStreamChunk: () => {} });
  assert.equal(text, '正文');
});

test('requestChatCompletion: SSE 帧内 error 对象透出错误', async () => {
  const f = sseFetch([
    'data: ' + JSON.stringify({ error: { message: 'quota exceeded' } }) + '\n\n',
  ]);
  await assert.rejects(
    requestChatCompletion(f, 'http://m/v1', 'k', {}, { onStreamChunk: () => {} }),
    /quota exceeded/,
  );
});

test('requestChatCompletion: SSE 解码 2/4 字节 UTF-8 与畸形序列（替换符兜底）', async () => {
  // é = 2 字节，😀 = 4 字节 surrogate pair，原始 0xFF 单字节 = 畸形序列 → U+FFFD
  const enc = new TextEncoder();
  const f = async () => new Response(
    new ReadableStream({
      start(controller) {
        const line = (payload) => enc.encode('data: ' + payload + '\n');
        controller.enqueue(line(JSON.stringify({ choices: [{ delta: { content: 'café😀' } }] })));
        controller.enqueue(new Uint8Array([0xff])); // 畸形：孤立的续字节位模式
        controller.enqueue(line(JSON.stringify({ choices: [{ delta: { content: '!' } }] })));
        controller.enqueue(enc.encode('data: [DONE]\n'));
        controller.close();
      },
    }),
    { status: 200 },
  );
  const text = await requestChatCompletion(f, 'http://m/v1', 'k', {}, { onStreamChunk: () => {} });
  // 畸形字节产出替换符且污染所在行前缀 → 该 SSE 帧被跳过但流不中断（与旧版断字语义一致）
  assert.equal(text, 'café😀');
});

// ---------------- 2026-10 增量落库 + 取消：流式 tool_calls / 取消信号（http 层） ----------------

const enc2 = new TextEncoder();

/** 把增量帧对象数组包成 SSE Response 的快捷构造 */
function sseResponse(frames) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const fr of frames) controller.enqueue(enc2.encode('data: ' + JSON.stringify(fr) + '\n\n'));
        controller.enqueue(enc2.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

test('requestChatCompletion: 流式 tool_calls 增量帧按 index 聚合为 message 对象', async () => {
  // OpenAI 兼容口径：tool_calls 增量字段（id/name/arguments）按分片拼接、按 index 分桶
  const f = sseFetch([
    'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'get_form_series', arguments: '{"da' } }] } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ys": 14}' } }, { index: 1, id: 'call_b', function: { name: 'x', arguments: '{}' } }] } }] }) + '\n\n',
    'data: [DONE]\n\n',
  ]);
  const res = await requestChatCompletion(f, 'http://m/v1', 'k', { stream: true }, { onStreamChunk: () => {} });
  assert.equal(res.role, 'assistant');
  assert.equal(res.tool_calls.length, 2); // 两个 index 分桶
  assert.deepEqual(res.tool_calls[0], {
    id: 'call_a',
    type: 'function',
    function: { name: 'get_form_series', arguments: '{"days": 14}' }, // arguments 跨帧拼接
  });
  assert.equal(res.tool_calls[1].id, 'call_b');
});

test('requestChatCompletion: 流式 tool_calls + 正文混合轮两者都保留', async () => {
  const f = sseFetch([
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '先看下数据' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'x', arguments: '{}' } }] } }] }) + '\n\n',
    'data: [DONE]\n\n',
  ]);
  const res = await requestChatCompletion(f, 'http://m/v1', 'k', { stream: true }, { onStreamChunk: () => {} });
  assert.equal(res.content, '先看下数据');
  assert.equal(res.tool_calls.length, 1);
});

test('requestChatCompletion: 整段 JSON 兜底带 tool_calls 回原 message 对象（不丢工具调用）', async () => {
  // 服务端无视 stream 回整段 JSON：此前带工具时会被降级成纯字符串，agent 循环拿不到 tool_calls
  const f = async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] } }] }),
      { status: 200 },
    );
  const res = await requestChatCompletion(f, 'http://m/v1', 'k', { stream: true }, { onStreamChunk: () => {} });
  assert.equal(res.tool_calls.length, 1);
  assert.equal(res.tool_calls[0].function.name, 'x');
});

test('requestChatCompletion: 流中途取消（AiCancelledError 为 reason）原样透出', async () => {
  const external = new AbortController();
  const f = async (_url, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(enc2.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '开头' } }] }) + '\n\n'));
          // 之后不再发数据也不关流；abort 时让挂起的 read() 拒绝
          init.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            controller.error(err);
          });
        },
      }),
      { status: 200 },
    );
  const p = requestChatCompletion(f, 'http://m/v1', 'k', { stream: true }, {
    signal: external.signal,
    onStreamChunk: () => {},
  });
  await sleep(30);
  external.abort(new AiCancelledError());
  await assert.rejects(p, (e) => e instanceof AiCancelledError);
});

test('requestChatCompletion: 重试等待期被取消抛取消原因（不补发、不误报传输错误）', async () => {
  let calls = 0;
  const f = async () => {
    calls += 1;
    return new Response('', { status: 200 }); // 空正文 → 传输级可重试
  };
  const external = new AbortController();
  const p = requestChatCompletion(f, 'http://m/v1', 'k', {}, { signal: external.signal, retryDelayMs: 300 });
  await sleep(30); // 首次已失败，正处重试等待中
  external.abort(new AiCancelledError());
  await assert.rejects(p, (e) => e instanceof AiCancelledError);
  assert.equal(calls, 1); // 等待期被取消不再补发
});

test('callAI: 外部取消优先于超时分类（不被误报成总超时）', async () => {
  const external = new AbortController();
  const p = callAI(hangFetch(), CFG, '提示词', { timeoutMs: 30000, signal: external.signal });
  await sleep(20);
  external.abort(new AiCancelledError());
  await assert.rejects(p, (e) => e instanceof AiCancelledError); // 若回归会抛「总时间超过」文案
});

// ---------------- 2026-10 增量落库 + 取消：agent 循环（incremental / 降级梯子 / 取消） ----------------

test('runAgentLoop: incremental 走流式轮，onProgress 上抛增长的最优正文', async () => {
  let calls = 0;
  const seenBodies = [];
  const f = async (_url, init) => {
    calls += 1;
    seenBodies.push(JSON.parse(init.body));
    if (calls === 1)
      return sseResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_form_series', arguments: '{"days":14}' } }] } }] }]);
    return sseResponse([
      { choices: [{ delta: { content: '短开头' } }] },
      { choices: [{ delta: { content: '，接着写更长的最终报告正文。' } }] },
    ]);
  };
  const progress = [];
  const startedTools = [];
  const text = await runAgentLoop(f, CFG, [{ role: 'user', content: '问' }], FAKE_TOOLS, async () => '{}', {
    timeoutMs: 5000,
    incremental: true,
    onProgress: (p) => progress.push(p),
    onToolStart: (n) => startedTools.push(n),
  });
  assert.equal(text, '短开头，接着写更长的最终报告正文。');
  assert.equal(seenBodies[0].stream, true); // 增量模式流式轮
  assert.deepEqual(startedTools, ['get_form_series']);
  // onProgress 只在超过既有最优时上抛（累计正文，非分片）；工具轮无正文不上抛
  assert.deepEqual(progress, ['短开头', '短开头，接着写更长的最终报告正文。']);
  // 次轮历史里有回填的 tool 消息
  assert.equal(seenBodies[1].messages.at(-1).role, 'tool');
  assert.equal(seenBodies[1].messages.at(-1).tool_call_id, 'call_1');
});

test('runAgentLoop: 流式轮传输失败自动降非流式重试（保工具，梯子第一级）', async () => {
  const f = jsonFetch((_body, idx) => {
    if (idx <= 1) return { status: 200, body: '' }; // 流式轮：http 层首次+重试都空正文（传输级）
    if (idx === 2) return toolCallMsg('get_form_series', { days: 7 }); // 循环降级：非流式保工具
    return msg('最终回答'); // 工具回填后的正文轮
  });
  const text = await runAgentLoop(f, CFG, [{ role: 'user', content: '问' }], FAKE_TOOLS, async () => '{}', {
    timeoutMs: 5000,
    incremental: true,
  });
  assert.equal(text, '最终回答');
  assert.equal(f.seen.length, 4);
  assert.equal(f.seen[0].body.stream, true);
  assert.equal(f.seen[1].body.stream, true); // http 层重试不切流式（带 tools）
  assert.equal(f.seen[2].body.stream, false); // 循环降级后非流式
  assert.deepEqual(f.seen[2].body.tools, FAKE_TOOLS); // 降级保工具（区别于弃工具的 400 降级）
});

test('runAgentLoop: 流式 400 → 非流式 400 → 弃工具降级（梯子走满，兼容三档端点）', async () => {
  const f = jsonFetch((_body, idx) => {
    if (idx === 0) return { status: 400, body: 'stream+tools unsupported' }; // 流式轮 400（http 不重试 4xx）
    if (idx === 1) return { status: 400, body: 'tools unsupported' }; // 循环降非流式（带工具）仍 400
    return msg('降级回答'); // 弃工具单轮
  });
  let degraded = null;
  const text = await runAgentLoop(f, CFG, [{ role: 'user', content: '问' }], FAKE_TOOLS, async () => '{}', {
    timeoutMs: 5000,
    incremental: true,
    onDegrade: (m) => (degraded = m),
  });
  assert.equal(text, '降级回答');
  assert.match(degraded, /400/);
  assert.equal(f.seen.length, 3);
  assert.equal(f.seen[0].body.stream, true);
  assert.equal(f.seen[1].body.stream, false); // 第二级：非流式保工具
  assert.equal('tools' in f.seen[2].body, false); // 第三级：弃工具
});

test('runAgentLoop: 外部取消中途 abort 抛 AiCancelledError（不误报总超时）', async () => {
  const external = new AbortController();
  const p = runAgentLoop(hangFetch(), CFG, [{ role: 'user', content: '问' }], [], async () => '{}', {
    timeoutMs: 30000,
    signal: external.signal,
  });
  await sleep(20);
  external.abort(new AiCancelledError());
  await assert.rejects(p, (e) => e instanceof AiCancelledError);
});

test('runAgentLoop: 非增量调用保持全非流式（记忆回顾轮等内部任务行为不变）', async () => {
  const f = jsonFetch((_b, idx) => (idx === 0 ? toolCallMsg('get_form_series', {}) : msg('回答')));
  const text = await runAgentLoop(f, CFG, [{ role: 'user', content: '问' }], FAKE_TOOLS, async () => '{}', { timeoutMs: 5000 });
  assert.equal(text, '回答');
  assert.equal(f.seen[0].body.stream, false);
  assert.equal(f.seen[1].body.stream, false);
});

// ---------------- code-review 修复批回归：截断检出 / 整段帧带工具 / 无 reason 取消 / 单轮流式降级 ----------------

test('requestChatCompletion: 流式有正文但无终止标记（干净 EOF 截断）判失败不重试', async () => {
  // code-review P1-1：推两帧后干净关流（无 [DONE]/finish_reason）——若静默返回，
  // 截断正文会以 completed 落库；必须抛不可重试错误（已吐字口径）
  const f = sseFetch([
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '报告前半段，' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '写到一半' } }] }) + '\n\n',
  ]);
  await assert.rejects(
    requestChatCompletion(f, 'http://m/v1', 'k', { stream: true }, { onStreamChunk: () => {} }),
    (e) => {
      assert.ok(e instanceof AiTransportError);
      assert.match(e.message, /未正常收尾/);
      assert.equal(e.retryable, false); // 已吐字不重发
      return true;
    },
  );
  assert.equal(f.seen.length, 1);
});

test('requestChatCompletion: finish_reason 非空即视为正常收尾（不发 [DONE] 的端点兼容）', async () => {
  const f = sseFetch([
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '正文' }, finish_reason: 'stop' }] }) + '\n\n',
  ]);
  const text = await requestChatCompletion(f, 'http://m/v1', 'k', { stream: true }, { onStreamChunk: () => {} });
  assert.equal(text, '正文');
});

test('requestChatCompletion: 整段 message 帧携带 tool_calls（无 delta 形态）照常聚合', async () => {
  // code-review P2-4：部分端点收 stream:true 仍一次性回完整 message——工具侧须与
  // 正文侧 wholeContent 同款兜底，否则丢工具调用并误报空响应
  const f = sseFetch([
    'data: ' + JSON.stringify({
      choices: [{
        message: {
          content: '先看下数据',
          tool_calls: [{ id: 'c1', index: 0, type: 'function', function: { name: 'x', arguments: '{"a":1}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    }) + '\n\n',
    'data: [DONE]\n\n',
  ]);
  const res = await requestChatCompletion(f, 'http://m/v1', 'k', { stream: true }, { onStreamChunk: () => {} });
  assert.equal(res.content, '先看下数据');
  assert.equal(res.tool_calls.length, 1);
  assert.equal(res.tool_calls[0].function.name, 'x');
});

test('callAI: 外部 abort 无 reason（RN polyfill 退化形）仍判取消而非超时', async () => {
  // code-review P2-3：本批最贵教训的回归钉——若实现退回"用 signal.reason 判身份"，
  // 无 reason 的 abort 会落进 /aborted|timeout/ 误报总超时，此用例即红
  const external = new AbortController();
  const p = callAI(hangFetch(), CFG, '提示词', { timeoutMs: 30000, signal: external.signal });
  await sleep(20);
  external.abort(); // 故意不带 reason
  await assert.rejects(p, (e) => e instanceof AiCancelledError);
});

test('runAgentLoop: 外部 abort 无 reason 同样判取消（非增量路径）', async () => {
  const external = new AbortController();
  const p = runAgentLoop(hangFetch(), CFG, [{ role: 'user', content: '问' }], [], async () => '{}', {
    timeoutMs: 30000,
    signal: external.signal,
  });
  await sleep(20);
  external.abort();
  await assert.rejects(p, (e) => e instanceof AiCancelledError);
});

test('callAI: forceStream 打开的流式被 400 拒 → 降非流式重试一次（code-review P2-1）', async () => {
  // 非 agentic 单轮路径没有 agent 循环的降级梯子：端点不支持 stream 时此前一次即败
  const seen = [];
  const f = jsonFetch((body, idx) => {
    seen.push(body);
    if (idx === 0) return { status: 400, body: 'stream unsupported' };
    return msg('非流式兜底成功');
  });
  const text = await callAI(f, { ...CFG, stream: false }, '提示词', { timeoutMs: 5000, forceStream: true });
  assert.equal(text, '非流式兜底成功');
  assert.equal(f.seen.length, 2);
  assert.equal(seen[0].stream, true);
  assert.equal(seen[1].stream, false);
});

test('callAI: 用户显式开启 stream 失败时不静默降级（尊重显式配置）', async () => {
  const f = jsonFetch(() => ({ status: 400, body: 'nope' }));
  await assert.rejects(
    callAI(f, { ...CFG, stream: true }, '提示词', { timeoutMs: 5000 }),
    /AI API 返回 400/,
  );
  assert.equal(f.seen.length, 1);
});

test('runAgentLoop（E1）：请求体压缩更旧轮 tool 结果，最近轮与 tool_call_id 配对保持', async () => {
  const f = jsonFetch((body, idx) => {
    if (idx < 2) {
      return {
        status: 200,
        body: {
          choices: [{
            message: {
              content: null,
              tool_calls: [
                { id: `c${idx}a`, type: 'function', function: { name: 'get_form_series', arguments: '{}' } },
                { id: `c${idx}b`, type: 'function', function: { name: 'get_form_series', arguments: '{}' } },
              ],
            },
          }],
        },
      };
    }
    return msg('done');
  });
  const big = 'R'.repeat(20000);
  const text = await runAgentLoop(
    f,
    CFG,
    [{ role: 'user', content: 'P' }],
    FAKE_TOOLS,
    async () => big,
    { timeoutMs: 5000 },
  );
  assert.equal(text, 'done');
  // 第三请求：第 1 轮的两条 tool 结果已降为占位，第 2 轮（最近）原样
  const sent = f.seen[2].body.messages;
  const t1a = sent.find((m) => m.role === 'tool' && m.tool_call_id === 'c0a');
  const t1b = sent.find((m) => m.role === 'tool' && m.tool_call_id === 'c0b');
  assert.equal(JSON.parse(t1a.content)._compacted, true);
  assert.equal(JSON.parse(t1b.content)._compacted, true);
  assert.equal(sent.find((m) => m.role === 'tool' && m.tool_call_id === 'c1a').content, big);
  // 请求总量远低于全量 4×20k；所有 tool_call_id 仍能找到对应 tool 消息
  const total = sent.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  assert.ok(total < 50_000, `total=${total}`);
  for (const id of ['c0a', 'c0b', 'c1a', 'c1b']) {
    assert.ok(sent.some((m) => m.role === 'tool' && m.tool_call_id === id), id);
  }
});
