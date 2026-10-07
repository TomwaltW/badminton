/**
 * 快照命名偏移：自动生成，勿手改。
 *
 * 契约草案 v0，待 10-11 人工审定冻结。
 *
 * 来源：packages/contracts/src/snapshot.schema.ts（SNAPSHOT_SCHEMA_VER = 0）。
 * 重新生成：bun run contracts:gen；检查是否最新：bun run contracts:gen --check（不同则退出 1）。
 *
 * SNAP_I32_<NAME> / SNAP_F64_<NAME> 是字段在 i32 / f64 数组里的起点，<...>_LEN 是该字段的槽数；
 * SNAP_I32_LEN / SNAP_F64_LEN 是总长。按球员展开的字段两段相邻：P1_<NAME> = P0_<NAME> + P0_<NAME>_LEN，
 * 所以球员 p 的起点 = SNAP_F64_P0_<NAME> + p × SNAP_F64_P0_<NAME>_LEN。
 */

// ---- I32 头（共 38 槽） ----

/** I32 头总长。 */
export const SNAP_I32_LEN = 38;

/** 魔数 'BMSS'（小端 int32 = SNAPSHOT_MAGIC）；1 槽 */
export const SNAP_I32_MAGIC = 0;
export const SNAP_I32_MAGIC_LEN = 1;

/** 快照布局版本（SNAPSHOT_SCHEMA_VER）；1 槽 */
export const SNAP_I32_SCHEMA_VER = 1;
export const SNAP_I32_SCHEMA_VER_LEN = 1;

/** simVer：dist/sim.js 字节的 FNV-1a（u32 按位存）；1 槽 */
export const SNAP_I32_SIM_VER = 2;
export const SNAP_I32_SIM_VER_LEN = 1;

/** contentHash：数值包规范化 JSON 的 FNV-1a（u32 按位存）；1 槽 */
export const SNAP_I32_CONTENT_HASH = 3;
export const SNAP_I32_CONTENT_HASH_LEN = 1;

/** 已步进的 tick 数 = 下一个要消费的 tick 号；1 槽 */
export const SNAP_I32_TICK = 4;
export const SNAP_I32_TICK_LEN = 1;

/** xorshift32 状态：AI-A 流（与 RNG_AI_B、RNG_SCATTER 相邻，顺序同 sim/rng.ts）；1 槽 */
export const SNAP_I32_RNG_AI_A = 5;
export const SNAP_I32_RNG_AI_A_LEN = 1;

/** xorshift32 状态：AI-B 流；1 槽 */
export const SNAP_I32_RNG_AI_B = 6;
export const SNAP_I32_RNG_AI_B_LEN = 1;

/** xorshift32 状态：散布流；1 槽 */
export const SNAP_I32_RNG_SCATTER = 7;
export const SNAP_I32_RNG_SCATTER_LEN = 1;

/** 对局阶段码（发球待机 / 回合中 / 死球 / 局间 / 终局；码值由 SIM 轨定义）；1 槽 */
export const SNAP_I32_PHASE = 8;
export const SNAP_I32_PHASE_LEN = 1;

/** 本局比分，下标为球员；2 槽 */
export const SNAP_I32_SCORE = 9;
export const SNAP_I32_SCORE_LEN = 2;

/** 已赢局数，下标为球员；2 槽 */
export const SNAP_I32_GAMES = 11;
export const SNAP_I32_GAMES_LEN = 2;

/** 发球方 0/1；1 槽 */
export const SNAP_I32_SERVER = 13;
export const SNAP_I32_SERVER_LEN = 1;

/** hit-stop 剩余冻结 tick 数（0 = 未冻结）；1 槽 */
export const SNAP_I32_HITSTOP_LEFT = 14;
export const SNAP_I32_HITSTOP_LEFT_LEN = 1;

/** 位置环最近一次写入的槽号 0..7（两名球员共用）；1 槽 */
export const SNAP_I32_POS_RING_HEAD = 15;
export const SNAP_I32_POS_RING_HEAD_LEN = 1;

/** MatchCfg 原样（encodeMatchCfg 布局，22 个 int32）；22 槽 */
export const SNAP_I32_MATCH_CFG = 16;
export const SNAP_I32_MATCH_CFG_LEN = 22;

// ---- F64 体（共 96 槽） ----

/** F64 体总长。 */
export const SNAP_F64_LEN = 96;

/** 球的位置 x, y, z（米）；3 槽 */
export const SNAP_F64_BALL_POS = 0;
export const SNAP_F64_BALL_POS_LEN = 3;

/** 球的速度 x, y, z（米/秒，已含 α）；3 槽 */
export const SNAP_F64_BALL_VEL = 3;
export const SNAP_F64_BALL_VEL_LEN = 3;

/** 缩放后的重力 g′ = α²·g；1 槽 */
export const SNAP_F64_BALL_G = 6;
export const SNAP_F64_BALL_G_LEN = 1;

/** 阻力系数 k（不随 α 变）；1 槽 */
export const SNAP_F64_BALL_K = 7;
export const SNAP_F64_BALL_K_LEN = 1;

/** 本次飞行的时间缩放 α；1 槽 */
export const SNAP_F64_BALL_ALPHA = 8;
export const SNAP_F64_BALL_ALPHA_LEN = 1;

/** 发射点 x, y, z（米）；3 槽 */
export const SNAP_F64_BALL_LAUNCH_POS = 9;
export const SNAP_F64_BALL_LAUNCH_POS_LEN = 3;

/** 发射速度 x, y, z（米/秒，已含 α）；3 槽 */
export const SNAP_F64_BALL_LAUNCH_VEL = 12;
export const SNAP_F64_BALL_LAUNCH_VEL_LEN = 3;

/** 发射时刻（绝对 u，整数）；1 槽 */
export const SNAP_F64_BALL_LAUNCH_U = 15;
export const SNAP_F64_BALL_LAUNCH_U_LEN = 1;

/** 球员 0：位置 x, y, z（米）；3 槽 */
export const SNAP_F64_P0_POS = 16;
export const SNAP_F64_P0_POS_LEN = 3;

/** 球员 1：位置 x, y, z（米）；3 槽 */
export const SNAP_F64_P1_POS = 19;
export const SNAP_F64_P1_POS_LEN = 3;

/** 球员 0：速度 x, y, z（米/秒）；3 槽 */
export const SNAP_F64_P0_VEL = 22;
export const SNAP_F64_P0_VEL_LEN = 3;

/** 球员 1：速度 x, y, z（米/秒）；3 槽 */
export const SNAP_F64_P1_VEL = 25;
export const SNAP_F64_P1_VEL_LEN = 3;

/** 球员 0：体力；1 槽 */
export const SNAP_F64_P0_STAMINA = 28;
export const SNAP_F64_P0_STAMINA_LEN = 1;

/** 球员 1：体力；1 槽 */
export const SNAP_F64_P1_STAMINA = 29;
export const SNAP_F64_P1_STAMINA_LEN = 1;

/** 球员 0：Focus 技能条 0..100；1 槽 */
export const SNAP_F64_P0_FOCUS = 30;
export const SNAP_F64_P0_FOCUS_LEN = 1;

/** 球员 1：Focus 技能条 0..100；1 槽 */
export const SNAP_F64_P1_FOCUS = 31;
export const SNAP_F64_P1_FOCUS_LEN = 1;

/** 球员 0：最近 8 个 tick 的位置环：槽 s 的 x, y, z 在 3s .. 3s+2；最新槽号见 I32 POS_RING_HEAD；24 槽 */
export const SNAP_F64_P0_POS_RING = 32;
export const SNAP_F64_P0_POS_RING_LEN = 24;

/** 球员 1：最近 8 个 tick 的位置环：槽 s 的 x, y, z 在 3s .. 3s+2；最新槽号见 I32 POS_RING_HEAD；24 槽 */
export const SNAP_F64_P1_POS_RING = 56;
export const SNAP_F64_P1_POS_RING_LEN = 24;

/** 球员 0：AI 反应计时：距"看到"来球还剩的 u（hit-stop 期间照走）；1 槽 */
export const SNAP_F64_P0_AI_REACT_U = 80;
export const SNAP_F64_P0_AI_REACT_U_LEN = 1;

/** 球员 1：AI 反应计时：距"看到"来球还剩的 u（hit-stop 期间照走）；1 槽 */
export const SNAP_F64_P1_AI_REACT_U = 81;
export const SNAP_F64_P1_AI_REACT_U_LEN = 1;

/** 球员 0：AI 带噪落点估计 x, z（米）；2 槽 */
export const SNAP_F64_P0_AI_EST = 82;
export const SNAP_F64_P0_AI_EST_LEN = 2;

/** 球员 1：AI 带噪落点估计 x, z（米）；2 槽 */
export const SNAP_F64_P1_AI_EST = 84;
export const SNAP_F64_P1_AI_EST_LEN = 2;

/** 球员 0：Lv10 习惯环最近一次写入的槽号（整数）；1 槽 */
export const SNAP_F64_P0_AI_HABIT_HEAD = 86;
export const SNAP_F64_P0_AI_HABIT_HEAD_LEN = 1;

/** 球员 1：Lv10 习惯环最近一次写入的槽号（整数）；1 槽 */
export const SNAP_F64_P1_AI_HABIT_HEAD = 87;
export const SNAP_F64_P1_AI_HABIT_HEAD_LEN = 1;

/** 球员 0：Lv10 习惯环：对手最近 4 拍的击球类型 SHOT（整数；−1 为空）；4 槽 */
export const SNAP_F64_P0_AI_HABIT = 88;
export const SNAP_F64_P0_AI_HABIT_LEN = 4;

/** 球员 1：Lv10 习惯环：对手最近 4 拍的击球类型 SHOT（整数；−1 为空）；4 槽 */
export const SNAP_F64_P1_AI_HABIT = 92;
export const SNAP_F64_P1_AI_HABIT_LEN = 4;
