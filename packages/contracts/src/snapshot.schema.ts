/**
 * 快照布局的数据定义（计划 2.5"快照布局"；方案 §3.3"快照"）。
 *
 * 契约草案 v0，待 10-11 人工审定冻结。冻结后到 12-21 前只许追加。
 *
 * 快照 = 两段定长数值数组：Int32Array 头（整数状态）+ Float64Array 体（浮点状态）。
 * 本文件只放有序字段表；命名偏移常量由 scripts/gen-snapshot-offsets.ts 生成到
 * src/gen/snapshot-offsets.ts（bun run contracts:gen；--check 检查是否最新）。
 *
 * 字段表规则：
 * - 每项 { name, count, perPlayer?, doc }，偏移按表中顺序连续分配，无空洞、无重叠。
 * - perPlayer 的字段展开成相邻两段 P0_<name>、P1_<name>（各 count 槽），
 *   因此球员 p 的起点 = P0 起点 + p × count，代码里不必分支。
 * - 两张表都只许在末尾追加（fixtures/snapshot-layout.v0.json 是基线，测试逐项比对前缀）。
 *   改名、删字段、改 count、插到中间都算破坏性变更：bump SNAPSHOT_SCHEMA_VER 并在 CHANGELOG 记一行。
 * - F64 体的最后是"只许追加的 AI 状态块"（AI_ 前缀），随 AI 实现逐步追加；v0 只放最小集合。
 * - 写入快照前 −0 归一为 0（normalizeNegZero）；调试版断言无 NaN（findNaN）。
 * - 派生缓存（预测轨迹等）不入快照，load 时重建。
 */

import { MATCH_CFG_I32_LEN } from './match-cfg';

/** 快照：I32 头 + F64 体。长度分别为 SNAP_I32_LEN、SNAP_F64_LEN（见 gen/snapshot-offsets.ts）。 */
export interface Snapshot {
  i32: Int32Array;
  f64: Float64Array;
}

/** 'BMSS' 的四个字节按小端读成 int32：0x42 'B'、0x4D 'M'、0x53 'S'、0x53 'S'。 */
export const SNAPSHOT_MAGIC = 0x53534d42;
/** 快照布局版本；草案阶段为 0。 */
export const SNAPSHOT_SCHEMA_VER = 0;
/** 每名球员保留最近 8 个 tick 的位置（计划 2.4：t* 通常已落后 1 tick + 最多 160 ms）。 */
export const POS_RING_LEN = 8;

/** 字段定义。 */
export interface SnapshotFieldDef {
  /** 大写下划线名字；生成常量 SNAP_I32_<name> / SNAP_F64_<name>。 */
  readonly name: string;
  /** 槽数（perPlayer 时为每名球员的槽数）。 */
  readonly count: number;
  /** 按球员展开为 P0_<name>、P1_<name> 两段相邻。 */
  readonly perPlayer?: boolean;
  /** 说明（中文），会写进生成文件的注释。 */
  readonly doc: string;
}

/** 展开后的一个槽段。 */
export interface SnapshotSlot {
  /** 展开后的名字（per-player 字段带 P0_/P1_ 前缀）。 */
  readonly name: string;
  /** 字段表里的名字。 */
  readonly field: string;
  /** −1 表示不分球员。 */
  readonly player: -1 | 0 | 1;
  readonly offset: number;
  readonly count: number;
  readonly doc: string;
}

export interface SnapshotLayout {
  readonly slots: readonly SnapshotSlot[];
  /** 总槽数。 */
  readonly length: number;
}

/** I32 头（计划 2.5）。顺序即偏移顺序。 */
export const SNAPSHOT_I32_FIELDS: readonly SnapshotFieldDef[] = [
  { name: 'MAGIC', count: 1, doc: "魔数 'BMSS'（小端 int32 = SNAPSHOT_MAGIC）" },
  { name: 'SCHEMA_VER', count: 1, doc: '快照布局版本（SNAPSHOT_SCHEMA_VER）' },
  { name: 'SIM_VER', count: 1, doc: 'simVer：dist/sim.js 字节的 FNV-1a（u32 按位存）' },
  { name: 'CONTENT_HASH', count: 1, doc: 'contentHash：数值包规范化 JSON 的 FNV-1a（u32 按位存）' },
  { name: 'TICK', count: 1, doc: '已步进的 tick 数 = 下一个要消费的 tick 号' },
  { name: 'RNG_AI_A', count: 1, doc: 'xorshift32 状态：AI-A 流（与 RNG_AI_B、RNG_SCATTER 相邻，顺序同 sim/rng.ts）' },
  { name: 'RNG_AI_B', count: 1, doc: 'xorshift32 状态：AI-B 流' },
  { name: 'RNG_SCATTER', count: 1, doc: 'xorshift32 状态：散布流' },
  { name: 'PHASE', count: 1, doc: '对局阶段码（发球待机 / 回合中 / 死球 / 局间 / 终局；码值由 SIM 轨定义）' },
  { name: 'SCORE', count: 2, doc: '本局比分，下标为球员' },
  { name: 'GAMES', count: 2, doc: '已赢局数，下标为球员' },
  { name: 'SERVER', count: 1, doc: '发球方 0/1' },
  { name: 'HITSTOP_LEFT', count: 1, doc: 'hit-stop 剩余冻结 tick 数（0 = 未冻结）' },
  { name: 'POS_RING_HEAD', count: 1, doc: '位置环最近一次写入的槽号 0..7（两名球员共用）' },
  { name: 'MATCH_CFG', count: MATCH_CFG_I32_LEN, doc: 'MatchCfg 原样（encodeMatchCfg 布局，22 个 int32）' },
];

/** F64 体（计划 2.5）。顺序即偏移顺序；AI_ 块必须在最后，且只许追加。 */
export const SNAPSHOT_F64_FIELDS: readonly SnapshotFieldDef[] = [
  // 球：前 8 槽与 sim/flight.ts 的 FL_* 布局一致（位置 3、速度 3、g′、k），可直接原地积分。
  { name: 'BALL_POS', count: 3, doc: '球的位置 x, y, z（米）' },
  { name: 'BALL_VEL', count: 3, doc: '球的速度 x, y, z（米/秒，已含 α）' },
  { name: 'BALL_G', count: 1, doc: '缩放后的重力 g′ = α²·g' },
  { name: 'BALL_K', count: 1, doc: '阻力系数 k（不随 α 变）' },
  { name: 'BALL_ALPHA', count: 1, doc: '本次飞行的时间缩放 α' },
  { name: 'BALL_LAUNCH_POS', count: 3, doc: '发射点 x, y, z（米）' },
  { name: 'BALL_LAUNCH_VEL', count: 3, doc: '发射速度 x, y, z（米/秒，已含 α）' },
  { name: 'BALL_LAUNCH_U', count: 1, doc: '发射时刻（绝对 u，整数）' },
  // 球员：每个字段 P0_/P1_ 相邻。
  { name: 'POS', count: 3, perPlayer: true, doc: '位置 x, y, z（米）' },
  { name: 'VEL', count: 3, perPlayer: true, doc: '速度 x, y, z（米/秒）' },
  { name: 'STAMINA', count: 1, perPlayer: true, doc: '体力' },
  { name: 'FOCUS', count: 1, perPlayer: true, doc: 'Focus 技能条 0..100' },
  {
    name: 'POS_RING',
    count: POS_RING_LEN * 3,
    perPlayer: true,
    doc: '最近 8 个 tick 的位置环：槽 s 的 x, y, z 在 3s .. 3s+2；最新槽号见 I32 POS_RING_HEAD',
  },
  // 只许追加的 AI 状态块（v0 最小集合）。
  { name: 'AI_REACT_U', count: 1, perPlayer: true, doc: 'AI 反应计时：距"看到"来球还剩的 u（hit-stop 期间照走）' },
  { name: 'AI_EST', count: 2, perPlayer: true, doc: 'AI 带噪落点估计 x, z（米）' },
  { name: 'AI_HABIT_HEAD', count: 1, perPlayer: true, doc: 'Lv10 习惯环最近一次写入的槽号（整数）' },
  { name: 'AI_HABIT', count: 4, perPlayer: true, doc: 'Lv10 习惯环：对手最近 4 拍的击球类型 SHOT（整数；−1 为空）' },
];

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * 由有序字段表计算布局：偏移连续分配，per-player 字段展开成 P0_/P1_ 两段相邻。
 * 检查名字格式（大写下划线、不以 _LEN 结尾）、count 为正整数、展开后的名字唯一；不合法抛 Error。纯函数。
 */
export function computeLayout(fields: readonly SnapshotFieldDef[]): SnapshotLayout {
  const slots: SnapshotSlot[] = [];
  const seen: { [name: string]: true } = {};
  let off = 0;
  const add = (name: string, f: SnapshotFieldDef, player: -1 | 0 | 1): void => {
    if (seen[name] === true) throw new Error(`快照字段名重复：${name}`);
    seen[name] = true;
    slots.push({ name, field: f.name, player, offset: off, count: f.count, doc: f.doc });
    off += f.count;
  };
  for (const f of fields) {
    if (!NAME_RE.test(f.name) || f.name === 'LEN' || f.name.slice(-4) === '_LEN') {
      throw new Error(`快照字段名不合法：${f.name}（只许大写字母、数字、下划线，且不能以 _LEN 结尾）`);
    }
    if (!(Math.floor(f.count) === f.count && f.count >= 1)) {
      throw new Error(`快照字段 ${f.name} 的 count 必须是正整数：${String(f.count)}`);
    }
    if (f.perPlayer === true) {
      add(`P0_${f.name}`, f, 0);
      add(`P1_${f.name}`, f, 1);
    } else {
      add(f.name, f, -1);
    }
  }
  return { slots, length: off };
}

export const SNAPSHOT_I32_LAYOUT: SnapshotLayout = computeLayout(SNAPSHOT_I32_FIELDS);
export const SNAPSHOT_F64_LAYOUT: SnapshotLayout = computeLayout(SNAPSHOT_F64_FIELDS);

/** 按展开后的名字查偏移；找不到抛 Error。 */
export function slotOffset(layout: SnapshotLayout, name: string): number {
  for (const s of layout.slots) if (s.name === name) return s.offset;
  throw new Error(`快照布局里没有字段：${name}`);
}

const I32_MAGIC = slotOffset(SNAPSHOT_I32_LAYOUT, 'MAGIC');
const I32_SCHEMA_VER = slotOffset(SNAPSHOT_I32_LAYOUT, 'SCHEMA_VER');

/** 新建一份全零快照，并写好 MAGIC 与 SCHEMA_VER。 */
export function createSnapshot(): Snapshot {
  const s: Snapshot = {
    i32: new Int32Array(SNAPSHOT_I32_LAYOUT.length),
    f64: new Float64Array(SNAPSHOT_F64_LAYOUT.length),
  };
  s.i32[I32_MAGIC] = SNAPSHOT_MAGIC;
  s.i32[I32_SCHEMA_VER] = SNAPSHOT_SCHEMA_VER;
  return s;
}

/** 检查快照的长度、魔数与布局版本；合法返回 null，否则返回中文错误。成功路径不分配。 */
export function validateSnapshotHeader(s: Snapshot): string | null {
  if (s.i32.length !== SNAPSHOT_I32_LAYOUT.length) {
    return `快照 I32 头长度应为 ${SNAPSHOT_I32_LAYOUT.length}，实际为 ${s.i32.length}`;
  }
  if (s.f64.length !== SNAPSHOT_F64_LAYOUT.length) {
    return `快照 F64 体长度应为 ${SNAPSHOT_F64_LAYOUT.length}，实际为 ${s.f64.length}`;
  }
  if (s.i32[I32_MAGIC] !== SNAPSHOT_MAGIC) return `快照魔数不是 'BMSS'：0x${(s.i32[I32_MAGIC] >>> 0).toString(16)}`;
  if (s.i32[I32_SCHEMA_VER] !== SNAPSHOT_SCHEMA_VER) {
    return `快照布局版本应为 ${SNAPSHOT_SCHEMA_VER}，实际为 ${s.i32[I32_SCHEMA_VER]}`;
  }
  return null;
}

/** 把 −0 归一为 +0（写快照、算哈希前调用）；返回归一的个数。零分配。 */
export function normalizeNegZero(f64: Float64Array): number {
  let n = 0;
  for (let i = 0; i < f64.length; i++) {
    const x = f64[i];
    if (x === 0 && 1 / x < 0) {
      f64[i] = 0;
      n++;
    }
  }
  return n;
}

/** 调试断言用：返回首个 NaN 的下标，没有则 −1。零分配。 */
export function findNaN(f64: Float64Array): number {
  for (let i = 0; i < f64.length; i++) {
    const x = f64[i];
    if (x !== x) return i;
  }
  return -1;
}
