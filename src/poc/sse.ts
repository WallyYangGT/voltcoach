/**
 * PoC 3 — expo/fetch 流式读取 chat/completions（SSE）。
 *
 * 默认打本地 mock 服务（scripts/mock-sse-server.mjs，经 `adb reverse tcp:8787 tcp:8787`
 * 把模拟器 127.0.0.1:8787 映射到宿主机）；填入真实 base_url/api_key/model 则直连
 * 用户自配的 OpenAI 兼容接口（如 Kimi），同一套流式解析代码。
 *
 * 通过标准：HTTP 200、收到 ≥ 10 个 data: 块、拼出非空 content、
 * 首块到达 < 5s、全流读完无中断。
 */
import { fetch } from 'expo/fetch';
import type { PocOptions, PocResult } from './types';

export async function runSsePoc(opts?: PocOptions): Promise<PocResult> {
  const baseUrl = (opts?.baseUrl || 'http://127.0.0.1:8787/v1').replace(/\/+$/, '');
  const model = opts?.model || 'mock-model';
  const apiKey = opts?.apiKey || '';

  const t0 = Date.now();
  let tFirstChunk = -1;
  let chunkCount = 0;
  let content = '';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'user', content: '用一句话介绍 NP（标准化功率）' }],
      }),
      signal: ctrl.signal,
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      return {
        pass: false,
        detail: `✗ HTTP ${res.status}${errText ? `: ${errText.slice(0, 200)}` : ''}\nURL: ${baseUrl}/chat/completions`,
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // 逐块解析 SSE：按 \n 分行，data: 前缀取 JSON，[DONE] 结束
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (tFirstChunk < 0) tFirstChunk = Date.now() - t0;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        chunkCount++;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') content += delta;
        } catch {
          // 忽略无法解析的块（如注释行/心跳）
        }
      }
    }

    const totalMs = Date.now() - t0;
    const pass = chunkCount >= 10 && content.length > 10;
    return {
      pass,
      detail: [
        `${pass ? '✓' : '✗'} URL: ${baseUrl}`,
        `data 块: ${chunkCount} · 首块 ${tFirstChunk}ms · 全流 ${totalMs}ms`,
        `拼出 content ${content.length} 字：${content.slice(0, 120)}${content.length > 120 ? '…' : ''}`,
      ].join('\n'),
    };
  } catch (err) {
    return {
      pass: false,
      detail: `✗ ${String(err)}\nURL: ${baseUrl}/chat/completions\n（默认打本地 mock：先在宿主机 node scripts/mock-sse-server.mjs，再 adb reverse tcp:8787 tcp:8787）`,
    };
  } finally {
    clearTimeout(timer);
  }
}
