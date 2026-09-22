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
 * 模拟器内经 http://10.0.2.2:8791 访问宿主（Windows adb reverse 不可靠，§AGENTS 踩坑）。
 */

import crypto from 'node:crypto';
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

/** 云端活动夹具：新→旧排列，fileKey 带 mock 厂商路径形状 */
function makeActivities(count = 5) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: 77000 + i,
    start_riding_time: fmt(new Date(now - (i + 1) * 24 * 3600 * 1000)),
    distance_km: 30 + i,
    time_seconds: 4500 + i * 60,
    fileKey: `geo/20260915/mock-ride-${77000 + i}.fit`,
    fitUrl: '',
  }));
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

export function createMockOnelapServer({ activityCount = 5, acceptPassword = null } = {}) {
  // acceptPassword：指定时校验密码（node:test 覆盖登录失败路径）；null 任意密码放行（模拟器联调）
  const acceptPasswordMd5 = acceptPassword === null
    ? null
    : crypto.createHash('md5').update(acceptPassword, 'utf8').digest('hex');
  const activities = makeActivities(activityCount);
  const fits = new Map(
    activities.map((a) => [a.id, buildRideFit({ durationSec: 60, power: 200 + (a.id % 7) * 10, heartRate: 150 })]),
  );

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (!process.env.NODE_TEST_CONTEXT) console.log(`[mock-onelap] ${req.method} ${path}`); // 单测下静默

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
  createMockOnelapServer().listen(port, () => {
    console.log(`[mock-onelap] listening on http://0.0.0.0:${port}（模拟器内用 http://10.0.2.2:${port}）`);
    console.log('[mock-onelap] 登录账号任意、密码任意；活动夹具 5 条（默认）');
  });
}
