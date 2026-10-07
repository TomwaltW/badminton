/**
 * 跨引擎互比（计划 6 章"确定性门禁"：跨引擎互比、不存期望值）。
 *
 * 每条路径（dsqrt / Math.sqrt）以第一个成功的引擎为基准，逐条比较检查点序列，再比最终哈希与 steps。
 * 检查点是 BadmintonSim.kernel.run({ checkpoints: true }) 返回的扁平数组，每 stride 个数一条：
 *   [种类, 拍号, 全局 tick, 滚动哈希 u32]
 * 种类：CP_TICK（每 30 tick 混入完整状态）/ CP_SHOT_END（一拍结束）。常量由 driver 从 sim.js 读出，
 * 这里不写死，只在缺省时退回 0 / 1 / 4。
 *
 * 纯函数，不读文件、不起进程，单测直接构造检查点数组。
 */

/** 一条路径在一个引擎上的结果（driver 输出里 paths.dsqrt / paths.mathSqrt 的子集）。 */
export interface PathRun {
  hash: number;
  steps: number;
  checkpoints: number[];
}

/** 检查点常量（由 driver 从 BadmintonSim.kernel 读出）。 */
export interface CheckpointLayout {
  stride: number;
  tick: number;
  shotEnd: number;
}

export const DEFAULT_LAYOUT: CheckpointLayout = { stride: 4, tick: 0, shotEnd: 1 };

/** 一条检查点。index 是第几条（从 0 起）。 */
export interface CheckpointRecord {
  index: number;
  kind: number;
  shot: number;
  tick: number;
  hash: number;
}

/**
 * 首个分歧。reason：
 * - checkpoint：同一位置的检查点不同（哈希、种类、拍号或 tick 任一不同）；
 * - length：一方的检查点序列先结束（base 或 other 之一为 null）；
 * - hash：检查点序列完全相同，但最终哈希不同（正常不会发生：最后一条检查点就是最终哈希）；
 * - steps：哈希与检查点都相同，只有 steps 不同。
 */
export interface Divergence {
  reason: 'checkpoint' | 'length' | 'hash' | 'steps';
  /** 分歧所在的检查点序号；hash / steps 分歧时为检查点条数。 */
  index: number;
  /** 分歧前最后一条双方相同的检查点（第一条就分歧时为 null）。真正的分歧发生在它之后。 */
  prev: CheckpointRecord | null;
  base: CheckpointRecord | null;
  other: CheckpointRecord | null;
  baseHash: number;
  otherHash: number;
  baseSteps: number;
  otherSteps: number;
}

/** 检查点数组的条数；长度不是 stride 的整数倍时抛错（driver 输出损坏）。 */
export function checkpointCount(cps: ArrayLike<number>, stride: number): number {
  if (cps.length % stride !== 0) throw new Error(`检查点数组长度 ${cps.length} 不是 ${stride} 的整数倍`);
  return cps.length / stride;
}

/** 取第 i 条检查点；越界返回 null。 */
export function recordAt(cps: ArrayLike<number>, i: number, layout: CheckpointLayout = DEFAULT_LAYOUT): CheckpointRecord | null {
  const o = i * layout.stride;
  if (i < 0 || o + layout.stride > cps.length) return null;
  return { index: i, kind: cps[o]!, shot: cps[o + 1]!, tick: cps[o + 2]!, hash: cps[o + 3]! };
}

function sameRecord(a: ArrayLike<number>, b: ArrayLike<number>, o: number, stride: number): boolean {
  for (let k = 0; k < stride; k++) if (a[o + k] !== b[o + k]) return false;
  return true;
}

/** 找出 other 相对 base 的首个分歧；完全一致返回 null。 */
export function firstDivergence(base: PathRun, other: PathRun, layout: CheckpointLayout = DEFAULT_LAYOUT): Divergence | null {
  const s = layout.stride;
  const nb = checkpointCount(base.checkpoints, s);
  const no = checkpointCount(other.checkpoints, s);
  const n = Math.min(nb, no);
  const tail = {
    prev: n > 0 ? recordAt(base.checkpoints, n - 1, layout) : null,
    baseHash: base.hash >>> 0,
    otherHash: other.hash >>> 0,
    baseSteps: base.steps,
    otherSteps: other.steps,
  };
  for (let i = 0; i < n; i++) {
    if (!sameRecord(base.checkpoints, other.checkpoints, i * s, s)) {
      return {
        ...tail,
        reason: 'checkpoint',
        index: i,
        prev: i > 0 ? recordAt(base.checkpoints, i - 1, layout) : null,
        base: recordAt(base.checkpoints, i, layout),
        other: recordAt(other.checkpoints, i, layout),
      };
    }
  }
  if (nb !== no) {
    return {
      ...tail,
      reason: 'length',
      index: n,
      base: recordAt(base.checkpoints, n, layout),
      other: recordAt(other.checkpoints, n, layout),
    };
  }
  if (tail.baseHash !== tail.otherHash) return { ...tail, reason: 'hash', index: n, base: null, other: null };
  if (base.steps !== other.steps) return { ...tail, reason: 'steps', index: n, base: null, other: null };
  return null;
}

/** u32 → 8 位小写十六进制。 */
export function hex8(u: number): string {
  return (u >>> 0).toString(16).padStart(8, '0');
}

/** 检查点种类的中文名。 */
export function kindLabel(kind: number, layout: CheckpointLayout = DEFAULT_LAYOUT): string {
  if (kind === layout.tick) return '30 tick 完整状态';
  if (kind === layout.shotEnd) return '一拍结束';
  return `未知种类 ${kind}`;
}

function describeRecord(r: CheckpointRecord, layout: CheckpointLayout): string {
  return `语料号（拍号）${r.shot}，全局 tick ${r.tick}，${kindLabel(r.kind, layout)}，哈希 ${hex8(r.hash)}`;
}

/**
 * 把首个分歧写成一段中文（多行，不带结尾换行）。baseName / otherName 是引擎名。
 * 检查点每 30 tick 才有一条，所以真正的分歧发生在"上一条检查点之后、这一条之前"。
 */
export function formatDivergence(
  d: Divergence,
  baseName: string,
  otherName: string,
  layout: CheckpointLayout = DEFAULT_LAYOUT,
): string {
  const lines: string[] = [];
  const pos = `第 ${d.index + 1} 条检查点`;
  if (d.reason === 'checkpoint' && d.base && d.other) {
    const b = d.base;
    const o = d.other;
    if (b.kind === o.kind && b.shot === o.shot && b.tick === o.tick) {
      lines.push(`首个分歧：${pos}，语料号（拍号）${b.shot}，全局 tick ${b.tick}，检查点种类：${kindLabel(b.kind, layout)}`);
      lines.push(`  ${baseName}：${hex8(b.hash)}`);
      lines.push(`  ${otherName}：${hex8(o.hash)}`);
    } else {
      lines.push(`首个分歧：${pos}，双方的检查点位置已不同`);
      lines.push(`  ${baseName}：${describeRecord(b, layout)}`);
      lines.push(`  ${otherName}：${describeRecord(o, layout)}`);
    }
    lines.push(
      d.prev
        ? `  真正的分歧发生在上一条相同的检查点（语料号（拍号）${d.prev.shot}，全局 tick ${d.prev.tick}，${kindLabel(d.prev.kind, layout)}）之后、这一条之前`
        : '  第一条检查点就已分歧：真正的分歧发生在语料开头到这一条之间',
    );
  } else if (d.reason === 'length') {
    const has = d.base ? d.base : d.other;
    const shortName = d.base ? otherName : baseName;
    const longName = d.base ? baseName : otherName;
    lines.push(`首个分歧：${pos}，${shortName} 的检查点序列已结束，${longName} 还有：`);
    if (has) lines.push(`  ${longName}：${describeRecord(has, layout)}`);
  } else if (d.reason === 'hash') {
    lines.push(`首个分歧：检查点序列相同（${d.index} 条），但最终哈希不同`);
    lines.push(`  ${baseName}：${hex8(d.baseHash)}`);
    lines.push(`  ${otherName}：${hex8(d.otherHash)}`);
  } else {
    lines.push(`首个分歧：哈希与检查点都相同，但 steps 不同`);
    lines.push(`  ${baseName}：${d.baseSteps}`);
    lines.push(`  ${otherName}：${d.otherSteps}`);
  }
  if (d.reason !== 'steps') {
    lines.push(
      `  最终：${baseName} ${hex8(d.baseHash)} / ${d.baseSteps} steps；${otherName} ${hex8(d.otherHash)} / ${d.otherSteps} steps`,
    );
  }
  return lines.join('\n');
}
