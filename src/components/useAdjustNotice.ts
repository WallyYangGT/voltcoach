/**
 * useAdjustNotice.ts — AI 调整披露条的「一次性披露」已读闸门（2026-10-18）。
 *
 * 语义：披露条在页面聚焦且业务数据条件成立时展示，并写已读锚（settings 的
 * adjust_notice_seen:<kind>，锚 = 该次调整身份）。**本次聚焦内保持可见**——撤销入口
 * 不因已读被抽走；下次进入页面（tab 切回/重进栈页/冷启动）读锚等于当前身份即不再出现。
 * 同一次聚焦内身份变化（计划页会话调整产生新版本 / FTP 新快照）→ 按新身份重新判定。
 *
 * 失败策略：读锚失败按未读展示（fail-open，宁可多显示一次）；写锚失败只告警，
 * 下次聚焦重试。写锚不阻塞撤销链路；首次读锚未完成前卡片暂不渲染（避免旧可见态
 * 闪一下），失焦即清空已读快照，重进先隐藏、读到锚后再决定。
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { getAdjustNoticeSeen, markAdjustNoticeSeen, type AdjustNoticeKind } from '@/db';

/** 聚焦时读到的已读锚；identity 用于对齐——旧身份的结果不参与新身份的判定 */
interface SeenSnapshot {
  identity: string;
  value: string | null;
}

export function useAdjustNoticeVisible(
  kind: AdjustNoticeKind,
  identity: string | null,
  dataAvailable: boolean,
): boolean {
  const [seen, setSeen] = useState<SeenSnapshot | null>(null);

  useFocusEffect(
    useCallback(() => {
      // 身份缺失（损坏行）fail-closed：不展示也不写锚，避免卡片永久常驻
      if (!dataAvailable || !identity) return undefined;
      let alive = true;
      void getAdjustNoticeSeen(kind)
        .then((value) => {
          if (alive) setSeen({ identity, value });
        })
        .catch((e) => {
          if (!alive) return;
          // 读失败按未读展示：披露条宁可多显示一次，也不能因读库异常永久隐藏
          console.warn('调整披露条已读锚读取失败，按未读展示:', e);
          setSeen({ identity, value: null });
        });
      return () => {
        alive = false;
        // 本次停留结束（失焦/身份变化）：清掉已读快照。重进首帧先隐藏，等读锚
        // 结果再决定——否则旧的可见态会让卡片先闪一下；同时让写锚失败在下次聚焦
        // 时重新触发（visible 经历 false→true）。
        setSeen(null);
      };
    }, [kind, identity, dataAvailable]),
  );

  const visible =
    dataAvailable && !!identity && seen?.identity === identity && seen.value !== identity;

  useEffect(() => {
    if (!visible || !identity) return;
    // 展示后才写锚：本次聚焦仍保持可见（撤销入口可用），下次聚焦读锚即隐藏
    void markAdjustNoticeSeen(kind, identity).catch((e) => {
      console.warn('调整披露条已读锚写入失败（下次聚焦重试）:', e);
    });
  }, [visible, kind, identity]);

  return visible;
}
