/**
 * dedupe.ts — 同趟骑行的内容指纹判定（纯函数层，M5）
 *
 * 背景：activities 的唯一去重键是 file_name，而两条入库路径给同一个文件取的名字
 * 几乎不可能逐字相同——手动导入存本地文件原名（safeName 只取 basename），顽鹿云
 * 同步存云端 fileKey 的 basename 且强制小写 .fit（sync/onelap.extractFitFileName）。
 * 于是「先前手动导入过、后来又被云同步拉到」的同一趟骑行会二次入库（2026-09-23
 * 真机复现）。这里按**解析结果的内容特征**判重，与文件名无关。
 *
 * 口径（2026-09-23 定）：同一 UTC 日期 + 时长 ±2s + 距离 ±0.05km。
 *  - 日期两侧都取自 records[0].timestamp 的 UTC 日期，同一份 FIT 必然相等；
 *  - 时长/距离留容差：同趟骑行经服务端转码（如顽鹿把 .st 日志转 FIT）可能有末秒差异；
 *  - 任一侧距离为空（室内骑行/缺数据）时**不判重**——宁可漏合也不误合，漏合的多余
 *    记录可由数据管理页的「重复检查」人工确认合并。
 */

/** 判定所需的骑行键（activities 行 / 待入库候选均可提供） */
export interface RideKey {
  date: string;
  duration_sec: number | null;
  distance_km: number | null;
}

/** 时长容差（秒）：吸收同一原始数据两次解析的末秒差异 */
export const RIDE_DURATION_TOLERANCE_SEC = 2;

/** 距离容差（km）：0.05km 远小于任何两趟不同骑行的实际差异，又能吸收舍入差异 */
export const RIDE_DISTANCE_TOLERANCE_KM = 0.05;

/** 两个数值是否在给定容差内相等（任一为空视为不可比） */
function withinTolerance(a: number | null, b: number | null, tol: number): boolean {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  // 差值先按 1e-6 取整再比较：消掉二进制浮点噪声（如 30.05-30 = 0.05000000000000071
  // 会把「恰好等于容差」判成超出），否则容差边界形同虚设
  const diff = Math.round(Math.abs(a - b) * 1e6) / 1e6;
  return diff <= tol;
}

/**
 * 是否同一趟骑行：日期必须完全相等，时长与距离都必须存在且落在容差内。
 * 只用于「新入库候选 vs 库内已有记录」与「库内记录互相比对」两种场景。
 */
export function isSameRide(a: RideKey, b: RideKey): boolean {
  if (!a.date || !b.date || a.date !== b.date) return false;
  if (!withinTolerance(a.duration_sec, b.duration_sec, RIDE_DURATION_TOLERANCE_SEC)) return false;
  return withinTolerance(a.distance_km, b.distance_km, RIDE_DISTANCE_TOLERANCE_KM);
}

/**
 * 库内记录按同趟骑行分组，返回**只含重复组**（每组 ≥2 条，组内保持入参顺序）。
 * 用并查集而非两两直接分组：容忍链式相等（A≈B、B≈C 视为一组）。
 */
export function findDuplicateGroups<T extends RideKey>(rows: T[]): T[][] {
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    // 路径压缩：长链（同一趟骑行的多份副本）查询退化为 O(α(n))
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (i: number, j: number) => {
    const [ri, rj] = [find(i), find(j)];
    if (ri !== rj) parent[ri] = rj;
  };

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (isSameRide(rows[i], rows[j])) union(i, j);
    }
  }

  const buckets = new Map<number, T[]>();
  for (let i = 0; i < rows.length; i++) {
    const root = find(i);
    const bucket = buckets.get(root);
    if (bucket) bucket.push(rows[i]);
    else buckets.set(root, [rows[i]]);
  }
  return [...buckets.values()].filter((g) => g.length > 1);
}

/**
 * 入库前的查重决策：候选（即将入库的文件名 + 骑行键）vs 库内全量行，
 * 命中同一趟骑行时返回**应让路的已有文件名**，否则 null（照常入库/更新）。
 *
 * 同名优先：库内已有同名行时直接返回 null —— 这是「重新导入同一文件」的更新路径，
 * 必须走 upsert 覆盖（口径与旧版一致）。否则「同名行 + 另一份云同步副本并存」时，
 * 再次导入该文件会被副本顶掉、同名行永远更新不到（2026-09-23 code-review 发现）。
 *
 * 已知边界（口径固有代价）：**同名但其实是两趟不同骑行时会被 upsert 覆盖**（本地那条
 * 的逐秒数据随之更新）。要区分只能给本地行存内容指纹或外部 id，本轮明确不做。
 */
export function findDuplicateOf(
  candidate: RideKey & { file_name: string },
  rows: (RideKey & { file_name: string })[],
): string | null {
  if (rows.some((r) => r.file_name === candidate.file_name)) return null;
  return rows.find((r) => isSameRide(r, candidate))?.file_name ?? null;
}
