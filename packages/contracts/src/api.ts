/**
 * 模拟 API、时间单位、输入与事件码（计划 2.3、2.4、2.5）。
 *
 * 契约草案 v0，待 10-11 人工审定冻结。
 *
 * 本文件只放常量与类型，不放实现：createSim 由 packages/sim 实现（SIM 轨），
 * 契约里只有它的类型 CreateSim。
 */

import type { MatchCfg } from './match-cfg';
import type { Snapshot } from './snapshot.schema';

// ---- 时间单位（计划 2.3、9.2 #6） ----

/** 模拟固定步频：每秒 30 个 tick。 */
export const SIM_HZ = 30;
/** 1u = 1/30000 s：一个 tick 与一毫秒都是整数个 u。 */
export const U_PER_TICK = 1000;
export const U_PER_MS = 30;
/** 每秒的 u 数 = SIM_HZ × U_PER_TICK = U_PER_MS × 1000 = 30000。 */
export const U_PER_SECOND = SIM_HZ * U_PER_TICK;

// ---- 输入（计划 2.3、2.4） ----

/**
 * 输入种类。0 保留为非法，避免全零记录被当成有效事件。
 * 编码只占第 5 字节的低 4 位（见 input-event.ts），以后最多扩到 15。
 */
export const INPUT_KIND = {
  /** 按下（开始蓄力 / 手势起点）。 */
  DOWN: 1,
  /** 松手（手势终点；判定以此刻打戳）。 */
  RELEASE: 2,
  /** 预判走位：点按场地改变待机基准点（tx/tz 为目标）。 */
  PREMOVE: 3,
  /** 取消（手势被系统打断、出屏等）。 */
  CANCEL: 4,
} as const;
export type InputKind = (typeof INPUT_KIND)[keyof typeof INPUT_KIND];

/** offMs 的下限：打戳早于消费 tick 起点 128 ms 以上的输入丢弃并计数（不进模拟、不进回放）。 */
export const INPUT_OFFSET_MIN_MS = -128;
/** offMs 的上限（i8）。本地输入恒 ≤ 0；正值只出现在 P2 的远端输入里。 */
export const INPUT_OFFSET_MAX_MS = 127;

export interface InputEvent {
  // 全整数；回放与 P2 线上同一 16 字节布局（input-event.ts）
  tick: number; // u32 被模拟"消费"的 tick（最早一个尚未步进的 tick）
  offMs: number; // i8 −128..+127：打戳时间相对该 tick 起点的毫秒，本地输入恒 ≤ 0；早于 −128 ms 的输入丢弃并计数
  player: 0 | 1;
  kind: InputKind; // DOWN | RELEASE | PREMOVE | CANCEL（与 player 共用 1 字节）
  tx: number; // i16 cm：触点投影到球场坐标（预判走位目标 / 瞄准落点）
  tz: number; // i16 cm
  dx: number; // i16 ‰屏宽：滑动向量（屏幕空间，用于手势分类）
  dy: number; // i16 ‰屏宽
  durMs: number; // u16 按下到松手
}

// ---- 模拟事件（drainEvents） ----

/**
 * 模拟事件码，从 1 编号（0 表示"无事件"，不会出现在输出里）。
 * 各事件的 player / arg0 / arg1 含义见 SIM_EVENT_STRIDE 的说明；v0 是建议值，随 SIM 轨细化。
 */
export const SIM_EVENT = {
  /** 发射（发球或回球后球离拍）。 */
  LAUNCH: 1,
  /** 接触（拍触球）。 */
  CONTACT: 2,
  /** 判定等级（Perfect / Good / Weak / Miss）。 */
  JUDGE: 3,
  /** hit-stop 冻结开始。 */
  HITSTOP: 4,
  /** 落地。 */
  BOUNCE: 5,
  /** 触网 / 下网。 */
  NET: 6,
  /** 出界。 */
  OUT: 7,
  /** 死球（本回合结束）。 */
  DEADBALL: 8,
  /** 得分。 */
  POINT: 9,
  /** 一局结束。 */
  GAME_END: 10,
} as const;
export type SimEventCode = (typeof SIM_EVENT)[keyof typeof SIM_EVENT];

/**
 * drainEvents 的打包格式（v0）：每条事件 SIM_EVENT_STRIDE = 4 个 int32，
 *
 *   out[4i + 0] = code | (player << 8)   低 8 位事件码（SIM_EVENT），bit8 为球员 0/1，其余位保留为 0
 *   out[4i + 1] = tick                    产生该事件的 tick（step 前的 tick 号）
 *   out[4i + 2] = arg0
 *   out[4i + 3] = arg1
 *
 * 时刻一律用绝对 u（tick × 1000 + 帧内 u；int32 可表示约 19.8 小时，远超一局）。
 * 各事件的 player / arg0 / arg1（v0 建议，随 SIM 轨细化）：
 *
 *   LAUNCH    player 发射方        arg0 击球类型 SHOT          arg1 发射时刻（绝对 u）
 *   CONTACT   player 击球方        arg0 接触时刻 t_c（绝对 u）  arg1 理想时刻 t*（绝对 u）
 *   JUDGE     player 击球方        arg0 判定等级 JUDGE_GRADE    arg1 误差 e = 打戳 − t*（u，有符号）
 *   HITSTOP   player 触发方        arg0 冻结 tick 数            arg1 原因（SIM_EVENT 码：CONTACT / DEADBALL / POINT）
 *   BOUNCE    player 落点所在半场  arg0 落点 x（毫米）          arg1 落点 z（毫米）
 *   NET       player 击球方        arg0 过网平面处高度（毫米）  arg1 0
 *   OUT       player 击球方        arg0 落点 x（毫米）          arg1 落点 z（毫米）
 *   DEADBALL  player 失分方        arg0 原因（SIM_EVENT 码：BOUNCE / NET / OUT / JUDGE（空挥））  arg1 0
 *   POINT     player 得分方        arg0 得分方本局分            arg1 对方本局分
 *   GAME_END  player 本局胜方      arg0 局号（从 0 起）         arg1 整场是否结束（0/1）
 *
 * drainEvents(out) 返回写入的事件条数 n（写满 out[0 .. 4n)）；out 放不下的事件留在队列里，下次再取。
 */
export const SIM_EVENT_STRIDE = 4;
/** 打包头里事件码的位宽与球员位。 */
export const SIM_EVENT_CODE_MASK = 0xff;
export const SIM_EVENT_PLAYER_SHIFT = 8;

/** 打包事件头：code | (player << 8)。 */
export function packSimEventHead(code: number, player: 0 | 1): number {
  return (code & SIM_EVENT_CODE_MASK) | (player << SIM_EVENT_PLAYER_SHIFT);
}
/** 从事件头取事件码。 */
export function simEventCode(head: number): number {
  return head & SIM_EVENT_CODE_MASK;
}
/** 从事件头取球员。 */
export function simEventPlayer(head: number): 0 | 1 {
  return (head >> SIM_EVENT_PLAYER_SHIFT) & 1 ? 1 : 0;
}

/** 判定等级（JUDGE 事件的 arg0；方案 §2.3 的窗口 ±50/±100/±160 ms）。0 保留。 */
export const JUDGE_GRADE = {
  PERFECT: 1,
  GOOD: 2,
  WEAK: 3,
  MISS: 4,
} as const;
export type JudgeGrade = (typeof JUDGE_GRADE)[keyof typeof JUDGE_GRADE];

/** 击球类型（击球表的第一根轴，从 0 起；方案 §2.3 的 8 种击球）。 */
export const SHOT = {
  /** 高远 */
  CLEAR: 0,
  /** 平高 */
  FLAT_CLEAR: 1,
  /** 吊球 */
  DROP: 2,
  /** 杀球 */
  SMASH: 3,
  /** 平抽 */
  DRIVE: 4,
  /** 搓放 */
  NET_SHOT: 5,
  /** 挑球 */
  LIFT: 6,
  /** 挡网 */
  BLOCK: 7,
} as const;
export type ShotId = (typeof SHOT)[keyof typeof SHOT];
export const SHOT_COUNT = 8;

// ---- predictContact 的输出布局（v0 建议，随 SIM 轨细化） ----

/** 理想时刻 t*（绝对 u，以 f64 存整数）。 */
export const PREDICT_T_U = 0;
/** 理想接触点 x、y、z（米）。 */
export const PREDICT_X = 1;
export const PREDICT_Y = 2;
export const PREDICT_Z = 3;
/** 若不接球的落点 x、z（米）与落地时刻（绝对 u）：落点阴影用。 */
export const PREDICT_LAND_X = 4;
export const PREDICT_LAND_Z = 5;
export const PREDICT_LAND_U = 6;
/** predictContact 的 out 至少要有这么长。 */
export const PREDICT_LEN = 7;

// ---- 数值包与击球表（计划 2.5；v0 占位接口，随 SIM 轨细化） ----

/** 判定三档的数值（Perfect / Good / Weak）。 */
export interface JudgeTriple {
  perfect: number;
  good: number;
  weak: number;
}

/** 单种击球的数值（v0 占位，随 SIM 轨细化）。 */
export interface ShotContent {
  /** 时间缩放 α_击球（方案 §2.4：g′ = α²g、v0′ = αv0、k 不变）。 */
  alpha: number;
  /** 力度倍率档：作用在 α 上（计划 9.1 #5：力度 = α 倍率，不是 v0 档）。 */
  powerScales: number[];
  /** 判定窗口（毫秒，相对理想时刻 t*）。 */
  windowMs: JudgeTriple;
  /** 落点散布（米）。 */
  scatterM: JudgeTriple;
  /** 判定速度修正（‰；如 Perfect +10%、Weak −15%）。 */
  speedPermille: JudgeTriple;
  /** 体力消耗。 */
  staminaCost: number;
  /** 最低过网高度（米，≥ 1.65）。 */
  minNetClearM: number;
}

/** 单档 AI 的数值（方案 §2.5 的参数表；v0 占位，随 SIM 轨细化）。 */
export interface AiLevelContent {
  reactionMs: number;
  estSigmaM: number;
  runSpeedPermille: number;
  unforcedErrorPermille: number;
  shotQuality: number;
  staminaAwareness: number;
  perfectPermille: number;
  habitMemory: number;
}

/** 手势分类阈值（v0 占位，随 SIM 轨与 input-map 细化）。 */
export interface GestureContent {
  tapMaxMs: number;
  swipeMinPermille: number;
  longSwipePermille: number;
  fastSwipeMs: number;
}

/** 分制（v0 占位）：先到 pointsToWin；deuceAt 平分后需领先 winBy；cap 封顶（0 为不封顶）。 */
export interface RulesContent {
  rulesId: number;
  pointsToWin: number;
  deuceAt: number;
  winBy: number;
  cap: number;
  gamesToWin: number;
}

/** 场地（米；方案 §2.1：单打 13.4 × 5.18，网高中央 1.524、边缘 1.55）。 */
export interface CourtContent {
  lengthM: number;
  widthM: number;
  netHeightCenterM: number;
  netHeightPostM: number;
  shortServiceLineM: number;
  shuttleRadiusM: number;
}

/** 体力（方案 §2.3 草案参数；v0 占位）。 */
export interface StaminaContent {
  max: number;
  perMeter: number;
  recoverPerSecond: number;
  lowThreshold: number;
  lowRunPenaltyPermille: number;
  lowScatterPenaltyPermille: number;
  lowSmashPerfectShrinkPermille: number;
}

/**
 * 数值包（计划 2.5）：规范化 JSON 的 FNV-1a = contentHash；随包发布，服务端按哈希归档所有版本。
 * v0 占位：只列要点字段，schema 10-13 由 SIM 轨定稿。
 */
export interface ContentBundle {
  /** 规范化 JSON 字节的 FNV-1a（u32）。写进回放头与快照头。 */
  readonly contentHash: number;
  /** 长度 SHOT_COUNT，下标即 SHOT。 */
  readonly shots: readonly ShotContent[];
  /** Lv1..Lv10，下标 0 = Lv1。 */
  readonly ai: readonly AiLevelContent[];
  readonly gesture: GestureContent;
  /** 各分制（5/7/11/15 分），按 rulesId 查找。 */
  readonly rules: readonly RulesContent[];
  readonly court: CourtContent;
  readonly stamina: StaminaContent;
}

/** 击球表的轴（计划 2.5）：击球 8 × 发射高度 0.4–3.2 m（0.2 步，15 档）× 水平距离 1–14 m（0.25 步，53 档）。 */
export const SHOT_TABLE_SHOTS = SHOT_COUNT;
export const SHOT_TABLE_H_MIN_M = 0.4;
export const SHOT_TABLE_H_STEP_M = 0.2;
export const SHOT_TABLE_H_COUNT = 15;
export const SHOT_TABLE_D_MIN_M = 1;
export const SHOT_TABLE_D_STEP_M = 0.25;
export const SHOT_TABLE_D_COUNT = 53;
/** 8 × 15 × 53 = 6360 格；float32 约 25 KB。 */
export const SHOT_TABLE_CELLS = SHOT_TABLE_SHOTS * SHOT_TABLE_H_COUNT * SHOT_TABLE_D_COUNT;

/**
 * 击球表（计划 2.5；content/gen/shot-tables.bin 解出后的形态）。v0 占位，生成器 10-14 由 SIM 轨定稿。
 * 下标 = (shot × H_COUNT + h) × D_COUNT + d。超出射程墙的目标已钳到最大射程斜率，valid 标 0。
 * 水平方向用 dsqrt 归一，运行时无三角函数。
 */
export interface ShotTables {
  /** shot-tables.bin 文件字节的 FNV-1a（u32）。写进回放头。 */
  readonly tablesHash: number;
  /** 发射斜率 vy / vh，长度 SHOT_TABLE_CELLS。 */
  readonly slope: Float32Array;
  /** 有效性掩码，长度 SHOT_TABLE_CELLS：1 可达，0 超出射程墙（已钳）。 */
  readonly valid: Uint8Array;
}

// ---- 模拟接口（计划 2.3） ----

export interface Sim {
  /** 恰好推进一个 tick；热路径零分配；AI 在内部决策。inputs 只含本 tick 消费的输入。 */
  step(inputs: ArrayLike<InputEvent>): void;
  /** 把完整状态写进 dst（−0 已归一，调试版断言无 NaN）。派生缓存（预测轨迹）不入快照。 */
  save(dst: Snapshot): void;
  /** 从 src 恢复完整状态，并重建派生缓存。 */
  load(src: Snapshot): void;
  /** FNV-1a over i32 + f64 位：等于对 save() 写出的快照先混 i32 全部、再混 f64 全部（u32）。 */
  hash(): number;
  /** 按先后取出 out 放得下的事件（打包格式见 SIM_EVENT_STRIDE），返回条数；放不下的留在队列里下次再取。 */
  drainEvents(out: Int32Array): number;
  /** 落点阴影、收缩环、AI 感知、音效预调度共用；out 布局见 PREDICT_*。无来球可接时返回 false。 */
  predictContact(p: 0 | 1, out: Float64Array): boolean;
  /** 渲染只读：位置、动作意图（蓄力至 tContact）、环相位、高度带提示。布局待 SIM 轨补 VIEW_* 偏移。 */
  readonly view: Float64Array;
}

/** 由 packages/sim 实现；契约里只有类型。 */
export type CreateSim = (cfg: MatchCfg, content: ContentBundle, tables: ShotTables) => Sim;
