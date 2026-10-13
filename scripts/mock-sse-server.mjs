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
 *   MOCK_TOOL_SCRIPT=plan —— v2 计划剧本：get_training_plan → 末轮正文附
 *   ```plan-json 块（3 周基础期，过 App 侧确定性校验），用于「周期规划 → 计划落库」冒烟。
 *   MOCK_TOOL_SCRIPT=plan_adjust —— 计划会话调整剧本：get_training_plan →
 *   update_training_plan 整体重发（阈值课顺延一天）→ 正文确认，用于「计划调整 → 新版本」冒烟。
 *   MOCK_TOOL_SCRIPT=memory —— 记忆回顾剧本：save_memory（scope=short 演示分层）→
 *   正文「已记录」。主生成轮与报告后记忆回顾轮各自最多触发一次记录，用于
 *   「报告后确定性记忆回顾 + 记忆页短期/长期分区」冒烟。
 *   MOCK_ECHO_PROMPT=1 —— 正文请求改为回显收到的最后一条 user 消息前 600 字符
 *   （前缀 [ECHO]），用于冒烟断言提示词里确实注入了新段落（如训练档案/策略段）
 *   —— mock 只回它"看到"的，App 侧报告正文即请求侧 prompt 的镜像。
 *   配合 MOCK_ECHO_CONTAIN=<子串>：不回显原文，改回「prompt N chars, contains
 *   "<子串>": YES/NO」——档案/策略段在 prompt 深处（skills 之后），盲回显 600 字
 *   够不着，用关键词断言直接给结论。
 */
import http from 'node:http';

const PORT = 8787;
const REPLY =
  'NP（Normalized Power，标准化功率）是 Coggan 功率体系的核心指标：' +
  '把逐秒功率先做 30 秒滚动平均、再取四次方均值后开四次方根，' +
  '用以反映变强度骑行的真实生理负荷，比平均功率更能刻画疲劳代价。'.repeat(2);
const ECHO_PROMPT = process.env.MOCK_ECHO_PROMPT === '1'; // 回显最后一条 user 消息（prompt 注入断言用）
const ECHO_CONTAIN = process.env.MOCK_ECHO_CONTAIN || ''; // 关键词包含断言（优先于盲回显）

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

// 计划剧本（MOCK_TOOL_SCRIPT=plan / plan_adjust）的夹具：以"今天"为锚构造 3 周窗口
// （3–42 天、覆盖未来），质量课间隔 ≥2 天、每周有休息日——须过 App 侧 create/adjust 校验
const planDay = (offset) =>
  new Date(Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z') + offset * 86400000)
    .toISOString()
    .slice(0, 10);
const pSession = (offset, type, duration_min = null, tss = null, note = null) => ({
  date: planDay(offset),
  type,
  duration_min,
  intensity: type === 'rest' ? null : '按 %FTP 区间',
  tss,
  note,
});
const mockPlanJson = (thresholdOffset) => ({
  valid_from: planDay(1),
  valid_to: planDay(21),
  goal: '基础期：有氧量与踏频稳定性（mock 冒烟计划）',
  sessions: [
    pSession(thresholdOffset, 'threshold', 75, 85, '3×12min 阈值，组间 5min'),
    pSession(3, 'rest', null, 0, '休息日'),
    pSession(4, 'endurance', 90, null, '有氧耐力'),
    pSession(6, 'rest', null, 0, '休息日'),
    pSession(8, 'sweet_spot', 60, null, '甜区 2×15min'),
    pSession(10, 'rest', null, 0, '休息日'),
    pSession(11, 'endurance', 120, null, '长骑'),
    pSession(13, 'rest', null, 0, '休息日'),
    pSession(15, 'vo2max', 45, null, 'VO2max 5×3min'),
    pSession(17, 'rest', null, 0, '休息日'),
    pSession(18, 'endurance', 90, null, '有氧耐力（减量周）'),
    pSession(20, 'rest', null, 0, '休息日'),
  ],
});
const PLAN_REPLY = () =>
  '## 本周期计划（基础期 3 周）\n\n' +
  '已结合近期负荷走势生成 3 周基础期计划：周节奏为 1 节质量课 + 有氧骑行 + 休息日，' +
  '第三周减量。结构化课表见下方数据块。\n\n' +
  '```plan-json\n' + JSON.stringify(mockPlanJson(1)) + '\n```';
const ADJUST_REPLY =
  '已把周一的阈值课顺延到周二（其余课次不变，质量课间隔仍满足 ≥48h），新版本已保存，可在计划页查看。';
// 记忆剧本（MOCK_TOOL_SCRIPT=memory）的收尾正文（也是冒烟时的报告正文）
const MEMORY_REPLY = '本次分析已完成；另按记忆规则补记了一条短期记忆（mock memory 剧本）。';
let memoryWrites = 0; // memory 剧本已发放 save_memory 的次数（第 1 次=主轮、第 2 次=回顾轮，内容区分以便断言两条都落库）
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

    // agentic 首轮（带 tools 且只有系统段/首条消息）→ 下发一次 save_memory 工具调用。
    // 带 TOOL_SCRIPT 剧本时让位：剧本按 role:"tool" 消息数推进，首轮被抢会错位
    const userMsgs = (parsed.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant');
    if (!TOOL_SCRIPT && !stream && Array.isArray(parsed.tools) && parsed.tools.length > 0 && userMsgs.length === 1) {
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

    // 计划剧本（MOCK_TOOL_SCRIPT=plan / plan_adjust）：按历史中 role:"tool" 消息数确定轮次
    if (
      !stream &&
      (TOOL_SCRIPT === 'plan' || TOOL_SCRIPT === 'plan_adjust') &&
      Array.isArray(parsed.tools) &&
      parsed.tools.length > 0
    ) {
      const toolMsgCount = (parsed.messages ?? []).filter((m) => m.role === 'tool').length;
      const steps =
        TOOL_SCRIPT === 'plan'
          ? [{ name: 'get_training_plan', args: {} }]
          : [
              { name: 'get_training_plan', args: {} },
              {
                name: 'update_training_plan',
                args: {
                  plan: mockPlanJson(2), // 阈值课 d1→d2（顺延一天），其余不变
                  change_note: '周一阈值课顺延至周二',
                },
              },
            ];
      if (toolMsgCount < steps.length) {
        const step = steps[toolMsgCount];
        console.log(`  -> mock script ${TOOL_SCRIPT}: issue ${step.name} (round ${toolMsgCount + 1})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `mock-plan-${toolMsgCount}`,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: `mock-plan-call-${toolMsgCount}`,
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
      // 剧本工具用尽 → 正文回复（plan 末轮附 plan-json 块，供 App 提取落库）
      const reply = TOOL_SCRIPT === 'plan' ? PLAN_REPLY() : ADJUST_REPLY;
      console.log(`  -> mock script ${TOOL_SCRIPT}: final reply`);
      contentCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `mock-${TOOL_SCRIPT}-final`,
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
        }),
      );
      return;
    }

    // 记忆剧本（MOCK_TOOL_SCRIPT=memory）：save_memory（scope=short 演示分层）→
    // 正文。按历史中 role:"tool" 消息数限一次——主生成轮与回顾轮各自走一遍。
    if (!stream && TOOL_SCRIPT === 'memory' && Array.isArray(parsed.tools) && parsed.tools.length > 0) {
      const toolMsgCount = (parsed.messages ?? []).filter((m) => m.role === 'tool').length;
      if (toolMsgCount < 1) {
        memoryWrites += 1;
        console.log(`  -> mock script memory: issue save_memory #${memoryWrites} (short scope)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'mock-memory-0',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'mock-memory-call-0',
                      type: 'function',
                      function: {
                        name: 'save_memory',
                        arguments: JSON.stringify({
                          content:
                            memoryWrites === 0
                              ? '冒烟测试短期记忆（主轮写入）：由 mock memory 剧本写入（两周/5 次失效口径）'
                              : '冒烟测试短期记忆（回顾轮写入）：报告后确定性回顾轮补记',
                          category: 'general',
                          scope: 'short',
                        }),
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
      console.log('  -> mock script memory: final reply');
      contentCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock-memory-final',
          choices: [{ index: 0, message: { role: 'assistant', content: MEMORY_REPLY }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
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
      // 回显模式：把最后一条 user 消息的开头镜像回报告正文（prompt 注入冒烟断言）
      let reply = REPLY;
      if (ECHO_PROMPT) {
        const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user');
        const content = String(lastUser?.content ?? '');
        reply = ECHO_CONTAIN
          ? `[ECHO] prompt ${content.length} chars, contains "${ECHO_CONTAIN}": ${content.includes(ECHO_CONTAIN) ? 'YES' : 'NO'}`
          : '[ECHO]' + content.slice(0, 600);
      }
      if (!stream) {
        const full = JSON.stringify({
          id: 'mock-1',
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
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
      const pieces = reply.match(new RegExp(`.{1,${chunkSize}}`, 'gu')) ?? [];
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
