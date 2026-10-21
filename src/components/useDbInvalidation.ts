/**
 * useDbInvalidation.ts — 页面订阅数据失效事件的 React 装配
 *
 * 用法：页面把「重取自己数据」的回调传进来，声明关心的域；db 写函数在成功路径发
 * 事件，命中域时回调被调用。
 *
 * ```ts
 * const { load } = usePageData();
 * useDbInvalidation(['activities', 'athlete'], load);
 * ```
 *
 * 三条口径：
 *  - **回调必须稳定或已被 useCallback 包好**——这里用 ref 保最新引用，依赖只取
 *    域列表的字符串键，回调换身份不会重订阅（避免内联箭头每次渲染都增删 listener）。
 *  - **回调里不得写库**（会与 db 失效事件形成回路）——需要写库的响应放 service。
 *  - 订阅是**叠加**在既有 `useFocusEffect` 焦点重查之上的兜底增强：写入发生时页面
 *    可能正可见（后台同步导入、AI 工具写库、另一个 tab 的操作），focus 不会触发，
 *    这里补上；focus 仍保留，覆盖「事件发出时页面未挂载」等情形。
 *
 * 从 `@/db/notify` 直连导入（不经 `@/db` barrel）：组件测试 mock `@/db` 时无需
 * 为新导出补键，且订阅面只有事件总线本身。
 */

import { useEffect, useRef } from 'react';
import { subscribeDbInvalidation, type DbDomain, type DbInvalidation } from '@/db/notify';

/**
 * 订阅若干域的数据失效事件。
 * @param domains 关心的域（数组身份不重要，内部按 join 出的键比较）
 * @param onInvalidate 命中时的重取回调（用 ref 保最新；不参与订阅依赖）。
 *   回调拿到事件本体，行级页面可据 `activityUuids` 过滤无关写入（如详情页只在
 *   本次骑行变化时重取，避免别处写入冲掉用户正在编辑的草稿）。
 */
export function useDbInvalidation(
  domains: readonly DbDomain[],
  onInvalidate: (ev: DbInvalidation) => void,
): void {
  // ref 保最新回调：调用方可以内联箭头函数而不引起重订阅。
  // 在 effect 里更新（`react-hooks/refs` 禁止渲染期写 ref）；本 effect 声明在订阅
  // effect 之前，挂载时先落地初值，之后每次渲染覆盖。
  const cbRef = useRef(onInvalidate);
  useEffect(() => {
    cbRef.current = onInvalidate;
  });

  const key = domains.join('|');

  useEffect(() => {
    const wanted = new Set(key ? (key.split('|') as DbDomain[]) : []);
    if (!wanted.size) return;
    return subscribeDbInvalidation((ev) => {
      for (const d of ev.domains) {
        if (wanted.has(d)) {
          cbRef.current(ev);
          return; // 一次事件只触发一次重取（多域命中不重复查）
        }
      }
    });
  }, [key]);
}
