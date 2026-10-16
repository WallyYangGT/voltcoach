/**
 * mock-igpsport-server.mjs — 迹驰（iGPSPORT）云 API 本地 mock（2026-10 多平台化）
 *
 * 复刻社区逆向口径的四段链路（登录 / queryMyActivity / queryActivityDetail +
 * getDownloadUrl / OSS 直链下载），用于模拟器端到端与 node:test：
 *   - 登录 `POST /service/auth/account/login`，校验 `appId='igpsport-web'` 与账号密码
 *     → `data.access_token`（业务码 `code:0`，区别于顽鹿的 200）；
 *   - 列表 `GET .../queryMyActivity`，按 `pageNo` 分页、**每页固定 20 条**（服务端截断的
 *     真实行为），支持 `beginTime/endTime` 过滤并在响应里回 `totalPage`；
 *   - 文件 `queryActivityDetail/{rideId}` 回 `data.fitUrl`；`getDownloadUrl/{rideId}` 回
 *     **字符串 data**（两种形态各留一半活动，客户端两条路径都要走对）；另有 `noFile`
 *     活动演练「云端无原始文件 → 计跳过而非失败」；
 *   - OSS 直链 `/oss/<name>.fit` **不校验任何鉴权头**（与真实 OSS 一致）。
 * 国内/国际两区共用本 mock（差异只有域名与 sortType 参数，客户端行为一致）。
 * FIT 字节由 test/make_test_fit.mjs 生成，起骑时刻跟活动元数据一致（防内容指纹把多条
 * 活动误判成一趟骑行——M5 踩过的坑）。
 *
 * 两种用法：
 *   node scripts/mock-igpsport-server.mjs        # 前台跑服务（默认 :8792，env MOCK_IGPSPORT_PORT）
 *   import { createMockIgpsportServer } from ...  # node:test 里起临时实例（端口 0）
 *
 * 模拟器内经 http://10.0.2.2:8792 访问宿主（Windows adb reverse 不可靠，见 docs/MAINTENANCE.md）。
 */

import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { buildRideFit } from '../test/make_test_fit.mjs';

/** mock 会话（登录成功后签发；列表/详情按此鉴权） */
const TOKEN = 'mock-igpsport-token';

/** 国内账号常见点分日期（`YYYY.MM.DD`）——客户端必须多格式解析（文件头 ② 的实证点） */
function fmtCn(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/** 国际账号常见 `YYYY-MM-DD HH:mm:ss` */
function fmtIntl(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 云端活动夹具（新→旧）。
 * - oldCount 追加「超过同步窗口（90 天）」的老活动，验证窗口截断（App 不应拉取）；
 * - 时间格式按索引交替 CN 点分/INTL 全格式，覆盖两种解析路径；
 * - fileRefVia 决定该活动的地址从 detail 还是 getDownloadUrl 拿（两条路径都要有覆盖率）；
 * - noFile 的活动两条路径都回空 = 演练跳过分支。
 */
function makeActivities(count = 5, oldCount = 0) {
  const now = Date.now();
  const recent = Array.from({ length: count }, (_, i) => {
    const start = new Date(now - (i + 1) * 24 * 3600 * 1000);
    return {
      id: 88000 + i,
      startTime: i % 2 === 0 ? fmtCn(start) : fmtIntl(start),
      distance: 30000 + i * 1000,
      movingTime: 4500 + i * 60,
      fileRefVia: i % 2 === 0 ? 'detail' : 'downloadUrl',
      noFile: i === count - 1 && count > 1, // 最旧一条无文件：验证「跳过而非失败」
      fileName: `iGPSPORT_2026-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}-${88000 + i}.fit`,
      startMs: start.getTime(),
    };
  });
  const old = Array.from({ length: oldCount }, (_, i) => {
    const start = new Date(now - (120 + i * 30) * 24 * 3600 * 1000);
    return {
      id: 87000 + i,
      startTime: fmtCn(start),
      distance: 20000,
      movingTime: 3600,
      fileRefVia: 'detail',
      noFile: false,
      fileName: `iGPSPORT_old-${87000 + i}.fit`,
      startMs: start.getTime(),
    };
  });
  return [...recent, ...old];
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

export function createMockIgpsportServer({
  activityCount = 5,
  oldActivityCount = 0,
  acceptPassword = null,
  revokeTokenOnce = false,
  fitFile = process.env.MOCK_FIT_FILE ?? null,
} = {}) {
  // acceptPassword：指定时校验密码（node:test 覆盖登录失败路径）；null 任意密码放行（联调）
  // revokeTokenOnce：首个带鉴权的请求回 401（模拟 token 过期），验证客户端自动重登一次
  // fitFile：指定时所有活动回该文件字节（演练「同一趟骑行、不同文件名」的跨源去重）
  let revokePending = revokeTokenOnce;
  const activities = makeActivities(activityCount, oldActivityCount);
  const fixedFit = fitFile ? fs.readFileSync(fitFile) : null;
  if (fixedFit) console.log(`[mock-igpsport] MOCK_FIT_FILE=${fitFile}：所有活动回同一份 FIT 字节（去重演练）`);
  const fits = new Map(
    activities.map((a) => [
      a.id,
      fixedFit ?? buildRideFit({ startMs: a.startMs, durationSec: 60, power: 210 + (a.id % 7) * 10, heartRate: 148 }),
    ]),
  );
  /** 直链地址按 mock 自身端口拼（客户端拿到后裸 GET，不带鉴权头） */
  const ossUrl = (port, act) => `http://127.0.0.1:${port}/oss/${encodeURIComponent(act.fileName)}`;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const port = req.socket.localPort;
    if (!process.env.NODE_TEST_CONTEXT) {
      console.log(`[mock-igpsport] ${new Date().toISOString().slice(11, 23)} ${req.method} ${path}`);
    }

    // ---------------- 登录：校验 appId 与账号密码 ----------------
    if (req.method === 'POST' && path === '/service/auth/account/login') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.appId !== 'igpsport-web' || !body.username || (acceptPassword !== null && body.password !== acceptPassword)) {
        return json(res, 200, { code: 1001, message: '账号或密码错误' });
      }
      return json(res, 200, {
        code: 0,
        message: 'success',
        data: {
          access_token: TOKEN,
          refresh_token: 'mock-igpsport-refresh',
          expires_in: 7200,
          token_type: 'Bearer',
          boundPhone: false,
        },
      });
    }

    // ---------------- 鉴权闸（列表/详情/下载地址共用；OSS 直链不走这里） ----------------
    if (path.startsWith('/service/')) {
      if (revokePending) {
        revokePending = false;
        console.log('[mock-igpsport] 已吊销 token：本次请求返回 401（预期客户端随后自动重登）');
        return json(res, 401, { code: 401, message: 'token expired (mock)' });
      }
      if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) {
        return json(res, 401, { code: 401, message: 'unauthorized' });
      }
    }

    // ---------------- 活动列表：pageNo 分页（每页固定 20 条）+ beginTime/endTime ----------------
    if (req.method === 'GET' && path === '/service/web-gateway/web-analyze/activity/queryMyActivity') {
      const pageNo = Number(url.searchParams.get('pageNo')) || 1;
      const pageSize = 20; // 真实服务端硬截断，忽略 pageSize 入参
      const begin = url.searchParams.get('beginTime');
      const norm = (t) => t.replace(/\./g, '-');
      const visible = begin ? activities.filter((a) => norm(a.startTime).slice(0, 10) >= begin) : activities;
      const slice = visible.slice((pageNo - 1) * pageSize, pageNo * pageSize);
      return json(res, 200, {
        code: 0,
        message: 'success',
        data: {
          rows: slice.map((a) => ({
            rideId: a.id,
            title: `骑行 ${a.id}`,
            startTime: a.startTime,
            rideDistance: a.distance,
            totalMovingTime: a.movingTime,
          })),
          pageNo,
          pageSize,
          totalRows: visible.length,
          totalPage: Math.max(1, Math.ceil(visible.length / pageSize)),
        },
      });
    }

    // ---------------- 活动详情：一半活动在此给 fitUrl ----------------
    const detail = /^\/service\/web-gateway\/web-analyze\/activity\/queryActivityDetail\/(\d+)$/.exec(path);
    if (req.method === 'GET' && detail) {
      const act = activities.find((a) => a.id === Number(detail[1]));
      if (!act) return json(res, 200, { code: 1004, message: 'no such activity' });
      return json(res, 200, {
        code: 0,
        message: 'success',
        data: {
          rideId: act.id,
          title: `骑行 ${act.id}`,
          // noFile：详情里没有 fitUrl（走下载地址端点也拿不到，见下）
          ...(act.fileRefVia === 'detail' && !act.noFile ? { fitUrl: ossUrl(port, act) } : {}),
        },
      });
    }

    // ---------------- 下载地址：data 为字符串 URL（另一半活动在此给） ----------------
    const dl = /^\/service\/web-gateway\/web-analyze\/activity\/getDownloadUrl\/(\d+)$/.exec(path);
    if (req.method === 'GET' && dl) {
      const act = activities.find((a) => a.id === Number(dl[1]));
      if (!act) return json(res, 200, { code: 1004, message: 'no such activity' });
      return json(res, 200, {
        code: 0,
        message: 'success',
        data: act.noFile || act.fileRefVia !== 'downloadUrl' ? '' : ossUrl(port, act),
      });
    }

    // ---------------- OSS 直链：**不校验鉴权头**（真实 OSS 口径） ----------------
    if (req.method === 'GET' && path.startsWith('/oss/')) {
      const name = decodeURIComponent(path.slice('/oss/'.length));
      const act = activities.find((a) => a.fileName === name);
      if (!act) return json(res, 404, { code: 404, message: `no such object: ${name}` });
      if ((req.headers.authorization ?? '') !== '') {
        // 直链本不该带鉴权；带上了也不报错（真实 OSS 同样忽略），只留痕提醒实现别多带
        console.log('[mock-igpsport] 注意：OSS 直链请求带了 Authorization 头（真实 OSS 会忽略，但没必要带）');
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(fits.get(act.id));
    }

    return json(res, 404, { code: 404, message: `no mock for ${req.method} ${path}` });
  });
}

// 直接运行：前台起服务（模拟器联调入口）
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const port = Number(process.env.MOCK_IGPSPORT_PORT) || 8792;
  const fitFile = process.env.MOCK_FIT_FILE ?? null;
  createMockIgpsportServer({
    activityCount: fitFile ? 1 : 5,
    oldActivityCount: 2,
    revokeTokenOnce: process.env.MOCK_REVOKE_ONCE === '1',
  }).listen(port, () => {
    console.log(`[mock-igpsport] listening on http://0.0.0.0:${port}（模拟器内用 http://10.0.2.2:${port}）`);
    console.log(
      fitFile
        ? `[mock-igpsport] 单活动，FIT 取自 ${fitFile}——用于验证「库里已有同一趟骑行」时同步跳过重复`
        : '[mock-igpsport] 登录账号任意、密码任意；5 条近 5 天（一半走 detail、一半走 getDownloadUrl，'
          + '最旧一条无文件应计跳过）+ 2 条 120/150 天前（验证同步窗口截断）',
    );
    if (process.env.MOCK_REVOKE_ONCE === '1') console.log('[mock-igpsport] 本实例首个鉴权请求将返回 401（验证令牌过期重登）');
  });
}
