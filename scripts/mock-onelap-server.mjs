/**
 * mock-onelap-server.mjs — 顽鹿云 API 本地 mock（M4 模拟器端到端用，§10.4）
 *
 * 复刻 OnelapSyncStrava 逆向口径的三个动作（login / ride_record/list /
 * ride_record/analysis*），登录签名按与客户端相同的 U+00D7 签名串校验——签名算法
 * 一旦被"顺手修正"这里会当场 401，是防回归的哨兵。FIT 字节用 test/make_test_fit.mjs
 * 生成，全链路不触碰真实顽鹿账号。
 *
 * 两种用法：
 *   node scripts/mock-onelap-server.mjs        # 前台跑服务（默认 :8791，env MOCK_ONELAP_PORT）
 *   import { createMockOnelapServer } from ...  # node:test 里起临时实例（端口 0）
 *
 * 模拟器内经 http://10.0.2.2:8791 访问宿主（Windows adb reverse 不可靠，见 docs/MAINTENANCE.md 构建已知坑）。
 *
 * M5 追加：FIT 的起骑时刻按活动的 start_riding_time 生成（此前是固定常量 2024-01-15，
 * 与列表元数据不符——内容指纹去重会把 5 条"同日期同时长"的活动误判成一趟骑行，
 * 而真实场景里每条活动的时刻各不相同）；MOCK_FIT_FILE=<本地 .fit 路径> 时改用该文件
 * 的字节服务所有活动，用于演练「同一趟骑行、不同文件名」的去重（手动导入 × 云同步）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { buildRideFit } from '../test/make_test_fit.mjs';

/** 登录签名密钥（与 src/sync/onelap.ts / Go 实现三方一致的约定值） */
const SECRET = 'fe9f8382418fcdeb136461cac6acae7b';

/** mock 会话（登录成功后签发；列表/下载按此鉴权） */
const TOKEN = 'mock-token-0123456789abcdef';
/** uid 故意取超 double 精度的整数：客户端必须从响应原文按数字串提取（JSON.parse 丢精度） */
const UID = '11122233344455566677';

/** 伪骑行时间格式（顽鹿口径 "YYYY-MM-DD HH:mm:ss"，本地时区） */
function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 云端活动夹具：新→旧排列，fileKey 带 mock 厂商路径形状。
 *  oldCount 追加「超过同步窗口（90 天）」的老活动，用于验证窗口截断——App 不应拉取它们 */
function makeActivities(count = 5, oldCount = 0) {
  const now = Date.now();
  const recent = Array.from({ length: count }, (_, i) => {
    const start = new Date(now - (i + 1) * 24 * 3600 * 1000);
    return {
      id: 77000 + i,
      start_riding_time: fmt(start),
      distance_km: 30 + i,
      time_seconds: 4500 + i * 60,
      fileKey: `geo/20260915/mock-ride-${77000 + i}.fit`,
      fitUrl: '',
      startMs: start.getTime(), // FIT 内容的起骑时刻与元数据一致（见文件头 M5 说明）
    };
  });
  const old = Array.from({ length: oldCount }, (_, i) => {
    const start = new Date(now - (120 + i * 30) * 24 * 3600 * 1000);
    return {
      id: 76000 + i,
      start_riding_time: fmt(start),
      distance_km: 20 + i,
      time_seconds: 3600,
      fileKey: `geo/20250101/mock-old-ride-${76000 + i}.fit`,
      fitUrl: '',
      startMs: start.getTime(),
    };
  });
  return [...recent, ...old]; // 新→旧：老活动排在后面，窗口外的项在翻页时才会遇到
}

/** 与客户端同口径的签名串（注意 ×tamp 的字面 U+00D7——改这里即 mock 全 401） */
function expectedSign({ account, nonce, passwordMd5, timestamp }) {
  return crypto
    .createHash('md5')
    .update(`account=${account}&nonce=${nonce}&password=${passwordMd5}\u00d7tamp=${timestamp}&key=${SECRET}`, 'utf8')
    .digest('hex');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' });
  res.end(body);
}

export function createMockOnelapServer({
  activityCount = 5,
  oldActivityCount = 0,
  acceptPassword = null,
  revokeTokenOnce = false,
  fitFile = process.env.MOCK_FIT_FILE ?? null,
} = {}) {
  // acceptPassword：指定时校验密码（node:test 覆盖登录失败路径）；null 任意密码放行（模拟器联调）
  // oldActivityCount：追加窗口外（>90 天）的老活动，验证同步窗口截断（默认关，不影响单测断言）
  // revokeTokenOnce：首个带鉴权的请求回 401（模拟 token 过期），验证客户端自动重登一次
  // fitFile：指定时所有活动都回该文件的字节（演练「同一趟骑行、不同文件名」的去重场景）
  const acceptPasswordMd5 = acceptPassword === null
    ? null
    : crypto.createHash('md5').update(acceptPassword, 'utf8').digest('hex');
  let revokePending = revokeTokenOnce;
  const activities = makeActivities(activityCount, oldActivityCount);
  const fixedFit = fitFile ? fs.readFileSync(fitFile) : null;
  if (fixedFit) {
    console.log(`[mock-onelap] MOCK_FIT_FILE=${fitFile}：所有活动回同一份 FIT 字节（去重演练）`);
  }
  const fits = new Map(
    activities.map((a) => [
      a.id,
      fixedFit ??
        buildRideFit({ startMs: a.startMs, durationSec: 60, power: 200 + (a.id % 7) * 10, heartRate: 150 }),
    ]),
  );

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (!process.env.NODE_TEST_CONTEXT) {
      // 带毫秒时间戳：便于核对客户端请求节流（活动之间应有 300–800ms 随机间隔）
      console.log(`[mock-onelap] ${new Date().toISOString().slice(11, 23)} ${req.method} ${path}`);
    }

    // ---------------- 登录：校验 nonce/timestamp/sign 三头 + 签名串 ----------------
    if (req.method === 'POST' && path === '/api/login') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const nonce = req.headers.nonce ?? '';
      const timestamp = req.headers.timestamp ?? '';
      const sign = req.headers.sign ?? '';
      if (nonce.length !== 16 || !/^\d+$/.test(String(timestamp))
        || (acceptPasswordMd5 !== null && body.password !== acceptPasswordMd5)
        || sign !== expectedSign({
        account: body.account ?? '',
        nonce,
        passwordMd5: body.password ?? '', // 客户端传来的已是 md5
        timestamp,
      })) {
        return json(res, 401, { code: 4001, message: 'sign verify failed' });
      }
      // uid 以裸 JSON 数字原样输出（保真测试点），响应串手工拼装避免 Number 精度污染
      return json(res, 200, `{"code":200,"message":"","data":[{"token":"${TOKEN}","refresh_token":"mock-refresh","userinfo":{"uid":${UID}}}]}`);
    }

    // ---------------- 鉴权闸（列表/详情/下载共用） ----------------
    const auth = req.headers.authorization ?? '';
    const ouid = /(?:^|;\s*)ouid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    if (revokePending) {
      // 一次性吊销：本次请求即回 401 模拟 token 过期（客户端应清缓存 → 重登 → 重试）
      revokePending = false;
      console.log('[mock-onelap] 已吊销 token：本次请求返回 401（预期客户端随后自动重登）');
      return json(res, 401, { code: 4003, message: 'token expired (mock)' });
    }
    if (auth !== TOKEN || ouid !== UID) {
      return json(res, 401, { code: 4003, message: 'unauthorized' });
    }

    // ---------------- 活动列表：新→旧 + 分页 ----------------
    if (req.method === 'POST' && path === '/api/otm/ride_record/list') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const page = Number(body.page) || 1;
      const limit = Number(body.limit) || 20;
      const slice = activities.slice((page - 1) * limit, page * limit);
      return json(res, 200, {
        code: 200,
        message: '',
        data: {
          list: slice.map(({ id, start_riding_time, distance_km, time_seconds }) => ({
            id,
            start_riding_time,
            distance_km,
            time_seconds,
          })),
          pagination: {
            current_page: page,
            per_page: limit,
            total: activities.length,
            total_pages: Math.ceil(activities.length / limit),
            has_more: page * limit < activities.length,
          },
        },
      });
    }

    // ---------------- 活动详情：取 fileKey ----------------
    const analysis = /^\/api\/otm\/ride_record\/analysis\/(\d+)$/.exec(path);
    if (req.method === 'GET' && analysis) {
      const act = activities.find((a) => a.id === Number(analysis[1]));
      if (!act) return json(res, 200, { code: 4004, message: 'no such activity' });
      return json(res, 200, {
        code: 200,
        message: '',
        data: { ridingRecord: { fileKey: act.fileKey, fitUrl: act.fitUrl, type: 27 } },
      });
    }

    // ---------------- FIT 下载：路径是 base64(fileKey) ----------------
    const content = /^\/api\/otm\/ride_record\/analysis\/fit_content\/([A-Za-z0-9+/=]+)$/.exec(path);
    if (req.method === 'GET' && content) {
      const key = Buffer.from(content[1], 'base64').toString('utf8');
      const act = activities.find((a) => a.fileKey === key);
      if (!act) return json(res, 200, { code: 4004, message: `unknown key: ${key}` });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(fits.get(act.id));
    }

    return json(res, 404, { code: 404, message: `no mock for ${req.method} ${path}` });
  });
}

// 直接运行：前台起服务（模拟器联调入口）。标准 isMain 判定（pathToFileURL 消 Windows 路径歧义）
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const port = Number(process.env.MOCK_ONELAP_PORT) || 8791;
  // 独立运行（模拟器联调）带 2 条窗口外老活动：应只见近期活动的 analysis/fit_content 请求
  // MOCK_REVOKE_ONCE=1 时首个鉴权请求回 401，用于验证客户端自动重登
  // MOCK_FIT_FILE=<本地 .fit 路径>：所有活动回同一份字节 → 演练「同趟骑行、不同文件名」去重
  const fitFile = process.env.MOCK_FIT_FILE ?? null;
  createMockOnelapServer({
    activityCount: fitFile ? 1 : 5,
    oldActivityCount: 2,
    revokeTokenOnce: process.env.MOCK_REVOKE_ONCE === '1',
  }).listen(port, () => {
    console.log(`[mock-onelap] listening on http://0.0.0.0:${port}（模拟器内用 http://10.0.2.2:${port}）`);
    console.log(
      fitFile
        ? `[mock-onelap] 单活动，FIT 取自 ${fitFile}——用于验证「库里已有同一趟骑行」时同步跳过重复`
        : '[mock-onelap] 登录账号任意、密码任意；活动 5 条近 5 天 + 2 条 120/150 天前（验证同步窗口截断）',
    );
    if (process.env.MOCK_REVOKE_ONCE === '1') console.log('[mock-onelap] 本实例首个鉴权请求将返回 401（验证令牌过期重登）');
  });
}
