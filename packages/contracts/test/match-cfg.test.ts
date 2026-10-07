/**
 * MatchCfg / PlayerCfg：22×i32 布局、编解码往返（seed 的 u32 位模式）、越界抛错、业务校验的中文错误。
 */
import { describe, expect, test } from 'bun:test';
import {
  AI_LEVEL_DEFAULT,
  MATCH_CFG_AB_GROUP,
  MATCH_CFG_DDA_ENABLED,
  MATCH_CFG_I32_LEN,
  MATCH_CFG_PLAYERS,
  MATCH_CFG_RULES_ID,
  MATCH_CFG_SEED,
  MATCH_CFG_STAMINA_ENABLED,
  MATCH_CFG_VENUE_ID,
  PLAYER_CFG_AI_LEVEL,
  PLAYER_CFG_ALPHA_SCALE_PERMILLE,
  PLAYER_CFG_I32_LEN,
  PLAYER_CFG_INPUT_OFFSET_MS,
  PLAYER_CFG_KIND,
  PLAYER_CFG_RUN_SPEED_PERMILLE,
  PLAYER_CFG_SCATTER_SCALE_PERMILLE,
  PLAYER_CFG_STAMINA_MAX_PERMILLE,
  PLAYER_CFG_WINDOW_SCALE_PERMILLE,
  PLAYER_KIND,
  RULES_ID,
  decodeMatchCfg,
  defaultMatchCfg,
  defaultPlayerCfg,
  encodeMatchCfg,
  matchCfgPlayerOffset,
  validateMatchCfg,
  type MatchCfg,
  type PlayerCfg,
} from '../src/match-cfg';

function rand32(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
}

function randomCfg(r: () => number): MatchCfg {
  const player = (): PlayerCfg => {
    const kind = (r() & 1) as 0 | 1;
    return {
      kind,
      aiLevel: kind === 0 ? 0 : 1 + (r() % 10),
      windowScalePermille: 1 + (r() % 5000),
      alphaScalePermille: 1 + (r() % 5000),
      scatterScalePermille: 1 + (r() % 5000),
      runSpeedPermille: 1 + (r() % 5000),
      staminaMaxPermille: 1 + (r() % 5000),
      inputOffsetMs: (r() % 301) - 150,
    };
  };
  const rulesId = 1 + (r() % 4);
  return {
    rulesId,
    seed: r(),
    venueId: r() % 100,
    ddaEnabled: rulesId === RULES_ID.RANKED11 ? 0 : ((r() & 1) as 0 | 1),
    staminaEnabled: (r() & 1) as 0 | 1,
    abGroup: r() % 16,
    players: [player(), player()],
  };
}

describe('布局', () => {
  test('22 个 int32：6 个对局字段 + 2 × 8 个球员字段，顺序同计划 2.3', () => {
    expect(MATCH_CFG_I32_LEN).toBe(22);
    expect([
      MATCH_CFG_RULES_ID,
      MATCH_CFG_SEED,
      MATCH_CFG_VENUE_ID,
      MATCH_CFG_DDA_ENABLED,
      MATCH_CFG_STAMINA_ENABLED,
      MATCH_CFG_AB_GROUP,
      MATCH_CFG_PLAYERS,
    ]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([
      PLAYER_CFG_KIND,
      PLAYER_CFG_AI_LEVEL,
      PLAYER_CFG_WINDOW_SCALE_PERMILLE,
      PLAYER_CFG_ALPHA_SCALE_PERMILLE,
      PLAYER_CFG_SCATTER_SCALE_PERMILLE,
      PLAYER_CFG_RUN_SPEED_PERMILLE,
      PLAYER_CFG_STAMINA_MAX_PERMILLE,
      PLAYER_CFG_INPUT_OFFSET_MS,
    ]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(PLAYER_CFG_I32_LEN).toBe(8);
    expect(matchCfgPlayerOffset(0)).toBe(6);
    expect(matchCfgPlayerOffset(1)).toBe(14);
  });

  test('编码按字段写到约定下标', () => {
    const cfg = defaultMatchCfg(0xdeadbeef);
    cfg.players[1].inputOffsetMs = -77;
    const a = new Int32Array(MATCH_CFG_I32_LEN);
    encodeMatchCfg(cfg, a, 0);
    expect(a[MATCH_CFG_RULES_ID]).toBe(RULES_ID.QUICK7);
    expect(a[MATCH_CFG_SEED]).toBe(0xdeadbeef | 0);
    expect(a[MATCH_CFG_STAMINA_ENABLED]).toBe(1);
    expect(a[matchCfgPlayerOffset(1) + PLAYER_CFG_KIND]).toBe(PLAYER_KIND.AI);
    expect(a[matchCfgPlayerOffset(1) + PLAYER_CFG_AI_LEVEL]).toBe(AI_LEVEL_DEFAULT);
    expect(a[matchCfgPlayerOffset(1) + PLAYER_CFG_INPUT_OFFSET_MS]).toBe(-77);
  });
});

describe('默认值', () => {
  test('defaultPlayerCfg：人 aiLevel = 0，AI 默认档 / 指定档；各缩放 1000‰', () => {
    expect(defaultPlayerCfg(PLAYER_KIND.HUMAN)).toEqual({
      kind: 0,
      aiLevel: 0,
      windowScalePermille: 1000,
      alphaScalePermille: 1000,
      scatterScalePermille: 1000,
      runSpeedPermille: 1000,
      staminaMaxPermille: 1000,
      inputOffsetMs: 0,
    });
    expect(defaultPlayerCfg(PLAYER_KIND.HUMAN, 7).aiLevel).toBe(0);
    expect(defaultPlayerCfg(PLAYER_KIND.AI).aiLevel).toBe(AI_LEVEL_DEFAULT);
    expect(defaultPlayerCfg(PLAYER_KIND.AI, 10).aiLevel).toBe(10);
  });

  test('defaultMatchCfg 合法，seed 归一为 u32', () => {
    const c = defaultMatchCfg(-1);
    expect(c.seed).toBe(4294967295);
    expect(validateMatchCfg(c)).toEqual([]);
    expect(c.players[0].kind).toBe(PLAYER_KIND.HUMAN);
    expect(c.players[1].kind).toBe(PLAYER_KIND.AI);
  });
});

describe('编解码往返', () => {
  test('seed 边界：0、2^31−1、2^31、2^32−1 都按 u32 读回', () => {
    for (const seed of [0, 1, 2147483647, 2147483648, 4294967295]) {
      const a = new Int32Array(MATCH_CFG_I32_LEN);
      const c = defaultMatchCfg(seed);
      encodeMatchCfg(c, a, 0);
      expect(a[MATCH_CFG_SEED]).toBe(seed | 0);
      const d = decodeMatchCfg(a, 0);
      expect(d.seed).toBe(seed);
      expect(d).toEqual(c);
    }
  });

  test('i32 位模式的负 seed 也能编码，读回为 u32', () => {
    const c = defaultMatchCfg(0);
    c.seed = -2;
    const a = new Int32Array(MATCH_CFG_I32_LEN);
    encodeMatchCfg(c, a, 0);
    expect(decodeMatchCfg(a, 0).seed).toBe(4294967294);
  });

  test('随机合法配置 500 例：编码 → 解码相等，且写在偏移处不碰相邻槽', () => {
    const r = rand32(0x1234567);
    for (let i = 0; i < 500; i++) {
      const c = randomCfg(r);
      expect(validateMatchCfg(c)).toEqual([]);
      const off = i % 7;
      const a = new Int32Array(MATCH_CFG_I32_LEN + 10).fill(-999);
      encodeMatchCfg(c, a, off);
      for (let k = 0; k < off; k++) expect(a[k]).toBe(-999);
      for (let k = off + MATCH_CFG_I32_LEN; k < a.length; k++) expect(a[k]).toBe(-999);
      expect(decodeMatchCfg(a, off)).toEqual(c);
    }
  });

  test('越界抛 RangeError（编码与解码）', () => {
    const c = defaultMatchCfg(1);
    expect(() => encodeMatchCfg(c, new Int32Array(21), 0)).toThrow(RangeError);
    expect(() => encodeMatchCfg(c, new Int32Array(30), 9)).toThrow(RangeError);
    expect(() => encodeMatchCfg(c, new Int32Array(30), -1)).toThrow(RangeError);
    expect(() => decodeMatchCfg(new Int32Array(22), 1)).toThrow(RangeError);
    expect(() => decodeMatchCfg(new Int32Array(22), 0.5)).toThrow(/放不下/);
  });

  test('会被 Int32Array 静默截断的值拒绝编码', () => {
    const a = new Int32Array(MATCH_CFG_I32_LEN);
    const c1 = defaultMatchCfg(1);
    c1.players[0].windowScalePermille = 1000.5;
    expect(() => encodeMatchCfg(c1, a, 0)).toThrow(/windowScalePermille/);
    const c2 = defaultMatchCfg(1);
    c2.seed = 4294967296;
    expect(() => encodeMatchCfg(c2, a, 0)).toThrow(/seed/);
    const c3 = defaultMatchCfg(1);
    c3.venueId = Number.NaN;
    expect(() => encodeMatchCfg(c3, a, 0)).toThrow(RangeError);
  });

  test('编码抛错时 dst 一个槽都不改（先整体检查再写）', () => {
    const mutators: ((c: MatchCfg) => void)[] = [
      (c) => (c.players[1].inputOffsetMs = 0.5), // 最后一个字段
      (c) => (c.players[1].kind = 1.5 as 1),
      (c) => (c.abGroup = Number.POSITIVE_INFINITY),
      (c) => (c.seed = -2147483649),
      (c) => (c.players[1] = null as unknown as PlayerCfg),
    ];
    for (const mutate of mutators) {
      const c = defaultMatchCfg(7);
      mutate(c);
      const a = new Int32Array(MATCH_CFG_I32_LEN + 4).fill(-7);
      expect(() => encodeMatchCfg(c, a, 2)).toThrow(RangeError);
      expect(Array.from(a).every((x) => x === -7)).toBe(true);
    }
  });
});

describe('validateMatchCfg', () => {
  const cases: [string, (c: MatchCfg) => void, RegExp][] = [
    ['rulesId 0', (c) => (c.rulesId = 0), /rulesId 未知/],
    ['rulesId 5', (c) => (c.rulesId = 5), /rulesId 未知/],
    ['seed 负数', (c) => (c.seed = -1), /seed/],
    ['seed 超出 u32', (c) => (c.seed = 4294967296), /seed/],
    ['seed 非整数', (c) => (c.seed = 1.5), /seed/],
    ['venueId 负数', (c) => (c.venueId = -1), /venueId/],
    ['ddaEnabled = 2', (c) => (c.ddaEnabled = 2 as 0), /ddaEnabled/],
    ['staminaEnabled = −1', (c) => (c.staminaEnabled = -1 as 0), /staminaEnabled/],
    [
      '排位赛开 DDA',
      (c) => {
        c.rulesId = RULES_ID.RANKED11;
        c.ddaEnabled = 1;
      },
      /排位赛/,
    ],
    ['abGroup 非整数', (c) => (c.abGroup = 0.5), /abGroup/],
    ['kind = 2', (c) => (c.players[0].kind = 2 as 0), /kind 只能是/],
    ['人的 aiLevel ≠ 0', (c) => (c.players[0].aiLevel = 3), /是人，aiLevel 必须为 0/],
    ['AI 的 aiLevel = 0', (c) => (c.players[1].aiLevel = 0), /是 AI，aiLevel 必须是 1..10/],
    ['AI 的 aiLevel = 11', (c) => (c.players[1].aiLevel = 11), /是 AI/],
    ['permille = 0', (c) => (c.players[0].alphaScalePermille = 0), /alphaScalePermille/],
    ['permille = 5001', (c) => (c.players[1].runSpeedPermille = 5001), /runSpeedPermille/],
    ['permille 非整数', (c) => (c.players[1].staminaMaxPermille = 999.9), /staminaMaxPermille/],
    ['inputOffsetMs = −151', (c) => (c.players[0].inputOffsetMs = -151), /inputOffsetMs/],
    ['inputOffsetMs = 151', (c) => (c.players[0].inputOffsetMs = 151), /inputOffsetMs/],
    ['inputOffsetMs 非整数', (c) => (c.players[0].inputOffsetMs = 0.5), /inputOffsetMs/],
    ['只有 1 名球员', (c) => (c.players = [c.players[0]] as unknown as MatchCfg['players']), /恰好 2 名/],
  ];
  for (const [name, mutate, re] of cases) {
    test(`拒绝：${name}`, () => {
      const c = defaultMatchCfg(42);
      mutate(c);
      const errs = validateMatchCfg(c);
      expect(errs.length).toBeGreaterThan(0);
      expect(errs.some((e) => re.test(e))).toBe(true);
      for (const e of errs) expect(e).toMatch(/[一-鿿]/);
    });
  }

  test('边界值合法：permille 1 / 5000、inputOffsetMs ±150、AI 1 / 10、四种分制', () => {
    const c = defaultMatchCfg(42);
    c.players[0].windowScalePermille = 1;
    c.players[0].scatterScalePermille = 5000;
    c.players[0].inputOffsetMs = -150;
    c.players[1].inputOffsetMs = 150;
    c.players[1].aiLevel = 1;
    expect(validateMatchCfg(c)).toEqual([]);
    c.players[1].aiLevel = 10;
    for (const id of Object.values(RULES_ID)) {
      c.rulesId = id;
      expect(validateMatchCfg(c)).toEqual([]);
    }
  });

  test('−0 不合法：每个整数字段 validate 报"|0 归一"，encodeMatchCfg 抛 RangeError 且 dst 不改', () => {
    // 回归：inputOffsetMs、ddaEnabled、人的 kind / aiLevel 等取 −0 曾能过校验，经 Int32Array 读回却成 +0。
    const negZero = Math.round(-0.3);
    const top = ['rulesId', 'seed', 'venueId', 'ddaEnabled', 'staminaEnabled', 'abGroup'] as const;
    const per = [
      'kind',
      'aiLevel',
      'windowScalePermille',
      'alphaScalePermille',
      'scatterScalePermille',
      'runSpeedPermille',
      'staminaMaxPermille',
      'inputOffsetMs',
    ] as const;
    const paths: [string, (c: MatchCfg) => void][] = [
      ...top.map((f): [string, (c: MatchCfg) => void] => [f, (c) => ((c as unknown as Record<string, number>)[f] = negZero)]),
      ...per.map((f): [string, (c: MatchCfg) => void] => [
        `players[0].${f}`,
        (c) => ((c.players[0] as unknown as Record<string, number>)[f] = negZero),
      ]),
      ['players[1].inputOffsetMs', (c) => (c.players[1].inputOffsetMs = negZero)],
    ];
    for (const [path, mutate] of paths) {
      const c = defaultMatchCfg(42);
      mutate(c);
      const errs = validateMatchCfg(c);
      const field = path.slice(path.lastIndexOf('.') + 1);
      expect([path, errs.some((e) => e.includes(field) && /−0 不合法：量化结果请 \|0 归一/.test(e))]).toEqual([path, true]);
      const a = new Int32Array(MATCH_CFG_I32_LEN + 2).fill(-7);
      expect(() => encodeMatchCfg(c, a, 1)).toThrow(RangeError);
      expect(() => encodeMatchCfg(c, a, 1)).toThrow(/−0 不合法/);
      expect([path, Array.from(a).every((x) => x === -7)]).toEqual([path, true]);
    }
    const ok = defaultMatchCfg(42);
    ok.players[0].inputOffsetMs = negZero | 0;
    expect(validateMatchCfg(ok)).toEqual([]);
    const a = new Int32Array(MATCH_CFG_I32_LEN);
    encodeMatchCfg(ok, a, 0);
    expect(decodeMatchCfg(a, 0)).toEqual(ok);
  });

  test('不是对象 / 球员缺失时返回中文错误而不是抛 TypeError', () => {
    for (const bad of [null, undefined, 42, 'cfg']) {
      const errs = validateMatchCfg(bad as unknown as MatchCfg);
      expect(errs.length).toBe(1);
      expect(errs[0]).toMatch(/MatchCfg 必须是对象/);
    }
    const c = defaultMatchCfg(1);
    c.players[0] = null as unknown as PlayerCfg;
    expect(validateMatchCfg(c)).toEqual(['players[0] 缺失']);
  });

  test('多个错误一并列出', () => {
    const c = defaultMatchCfg(42);
    c.rulesId = 99;
    c.players[0].inputOffsetMs = 999;
    c.players[1].aiLevel = 0;
    expect(validateMatchCfg(c).length).toBe(3);
  });

  test('人对人、AI 对 AI 都合法（arena 无头对战需要后者）', () => {
    const c = defaultMatchCfg(1);
    c.players = [defaultPlayerCfg(PLAYER_KIND.AI, 3), defaultPlayerCfg(PLAYER_KIND.AI, 9)];
    expect(validateMatchCfg(c)).toEqual([]);
    c.players = [defaultPlayerCfg(PLAYER_KIND.HUMAN), defaultPlayerCfg(PLAYER_KIND.HUMAN)];
    expect(validateMatchCfg(c)).toEqual([]);
  });
});
