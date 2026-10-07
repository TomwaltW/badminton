/**
 * BMRP 回放：夹具 decode 等于 JSON、JSON encode 字节等于夹具、随机回放往返、
 * 改坏 magic / fmt / 校验 / 截断 / 字段 → 抛 ReplayError、AI 输入被拒；校验与 sim 的 fnvBytes 一致。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INPUT_KIND, type InputEvent, type InputKind } from '../src/api';
import { IE_KIND_PLAYER, IE_TICK, INPUT_EVENT_BYTES } from '../src/input-event';
import { PLAYER_KIND, RULES_ID, defaultMatchCfg, defaultPlayerCfg, type MatchCfg } from '../src/match-cfg';
import {
  REPLAY_FMT,
  REPLAY_CHECKSUM_BYTES,
  REPLAY_HASH_EVERY_TICKS,
  REPLAY_HEADER_BYTES,
  REPLAY_MIN_BYTES,
  RP_FMT,
  RP_INPUTS,
  RP_INPUT_COUNT,
  RP_MATCH_CFG,
  RP_RESERVED,
  ReplayError,
  decodeReplay,
  encodeReplay,
  replayByteLength,
  replayFnv1a,
  replayHashCount,
  validateReplay,
  type Replay,
  type ReplayErrorCode,
} from '../src/replay';
import { fnvBytes } from '../../sim/src/hash';

const FIX_DIR = resolve(import.meta.dir, '../fixtures');
const fixtureBytes = new Uint8Array(readFileSync(resolve(FIX_DIR, 'replay-v0.bmrp')));
const fixtureJson = (JSON.parse(readFileSync(resolve(FIX_DIR, 'replay-v0.json'), 'utf8')) as { replay: Replay }).replay;

function rand32(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
}

/** 改完字节后重写尾部校验，让错误落到字段校验上。 */
function reseal(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  new DataView(bytes.buffer, bytes.byteOffset, n).setUint32(n - 4, replayFnv1a(bytes, 0, n - 4), true);
  return bytes;
}

function expectReplayError(fn: () => unknown, code: ReplayErrorCode, re?: RegExp): void {
  let err: unknown = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ReplayError);
  const re2 = err as ReplayError;
  expect(re2.code).toBe(code);
  expect(re2.name).toBe('ReplayError');
  expect(re2.message).toMatch(/[一-鿿]/);
  if (re) expect(re2.message).toMatch(re);
}

function minimalReplay(): Replay {
  return { simVer: 0, contentHash: 0, tablesHash: 0, cfg: defaultMatchCfg(0), inputs: [], totalTicks: 0, hashes: [], games: [] };
}

const KINDS: InputKind[] = [INPUT_KIND.DOWN, INPUT_KIND.RELEASE, INPUT_KIND.PREMOVE, INPUT_KIND.CANCEL];

function randomReplay(r: () => number): Replay {
  const kinds = [r() % 3, r() % 3].map((k) => (k === 0 ? PLAYER_KIND.AI : PLAYER_KIND.HUMAN)) as (0 | 1)[];
  const cfg: MatchCfg = {
    rulesId: 1 + (r() % 4),
    seed: r(),
    venueId: r() % 8,
    ddaEnabled: 0,
    staminaEnabled: (r() & 1) as 0 | 1,
    abGroup: r() % 4,
    players: [defaultPlayerCfg(kinds[0]!, 1 + (r() % 10)), defaultPlayerCfg(kinds[1]!, 1 + (r() % 10))],
  };
  const humans = ([0, 1] as const).filter((p) => cfg.players[p].kind === PLAYER_KIND.HUMAN);
  const totalTicks = r() % 3 === 0 ? r() % 40 : r() % 12000;
  const inputs: InputEvent[] = [];
  if (humans.length > 0 && totalTicks > 0) {
    const n = r() % 60;
    const ticks = Array.from({ length: n }, () => r() % totalTicks).sort((a, b) => a - b);
    for (const tick of ticks) {
      inputs.push({
        tick,
        offMs: -(r() % 129) | 0,
        player: humans[r() % humans.length]!,
        kind: KINDS[r() % 4]!,
        tx: (r() % 65536) - 32768,
        tz: (r() % 65536) - 32768,
        dx: (r() % 65536) - 32768,
        dy: (r() % 65536) - 32768,
        durMs: r() % 65536,
      });
    }
  }
  const hashes = Array.from({ length: replayHashCount(totalTicks) }, () => r());
  const games: [number, number][] = Array.from({ length: r() % 4 }, () => [r() % 65536, r() % 65536]);
  return { simVer: r(), contentHash: r(), tablesHash: r(), cfg, inputs, totalTicks, hashes, games };
}

describe('夹具（fixtures/replay-v0.*）', () => {
  test('二进制夹具 decode 等于 JSON 夹具', () => {
    expect(decodeReplay(fixtureBytes)).toEqual(fixtureJson);
  });

  test('JSON 夹具 encode 的字节等于二进制夹具', () => {
    expect(encodeReplay(fixtureJson)).toEqual(fixtureBytes);
  });

  test('夹具覆盖：有输入、有哈希、同 tick 两条、seed 高位为 1、对手是 AI', () => {
    expect(fixtureJson.inputs.length).toBeGreaterThan(10);
    expect(fixtureJson.hashes.length).toBe(replayHashCount(fixtureJson.totalTicks));
    const t = fixtureJson.inputs.map((e) => e.tick);
    expect(t.some((x, i) => i > 0 && x === t[i - 1])).toBe(true);
    expect(fixtureJson.cfg.seed).toBeGreaterThan(0x7fffffff);
    expect(fixtureJson.cfg.players[1].kind).toBe(PLAYER_KIND.AI);
  });

  test('魔数、版本、保留字与头部偏移', () => {
    expect(String.fromCharCode(...fixtureBytes.subarray(0, 4))).toBe('BMRP');
    const v = new DataView(fixtureBytes.buffer, fixtureBytes.byteOffset, fixtureBytes.byteLength);
    expect(v.getUint16(RP_FMT, true)).toBe(REPLAY_FMT);
    expect(v.getUint16(RP_RESERVED, true)).toBe(0);
    expect(RP_MATCH_CFG).toBe(20);
    expect(RP_INPUT_COUNT).toBe(108);
    expect(REPLAY_HEADER_BYTES).toBe(112);
    expect(v.getUint32(RP_INPUT_COUNT, true)).toBe(fixtureJson.inputs.length);
    expect(v.getUint32(RP_MATCH_CFG + 4, true)).toBe(fixtureJson.cfg.seed);
  });

  test('尾部校验 = 前面所有字节的 FNV-1a，与 sim 的 fnvBytes 相同', () => {
    const n = fixtureBytes.length;
    const v = new DataView(fixtureBytes.buffer, fixtureBytes.byteOffset, n);
    expect(v.getUint32(n - 4, true)).toBe(fnvBytes(fixtureBytes.subarray(0, n - 4)));
  });

  test('手算尾部布局：totalTicks、hashCount、首末哈希、局数、每局 2×u16、校验（不经 decodeReplay）', () => {
    const n = fixtureBytes.length;
    const v = new DataView(fixtureBytes.buffer, fixtureBytes.byteOffset, n);
    const tailAt = RP_INPUTS + INPUT_EVENT_BYTES * fixtureJson.inputs.length;
    const hc = fixtureJson.hashes.length;
    expect(v.getUint32(tailAt, true)).toBe(fixtureJson.totalTicks);
    expect(v.getUint32(tailAt + 4, true)).toBe(hc);
    expect(v.getUint32(tailAt + 8, true)).toBe(fixtureJson.hashes[0]!);
    expect(v.getUint32(tailAt + 8 + 4 * (hc - 1), true)).toBe(fixtureJson.hashes[hc - 1]!);
    const gamesCountAt = tailAt + 8 + 4 * hc;
    expect(v.getUint8(gamesCountAt)).toBe(fixtureJson.games.length);
    expect(fixtureJson.games).toEqual([[7, 5]]);
    expect(v.getUint16(gamesCountAt + 1, true)).toBe(7);
    expect(v.getUint16(gamesCountAt + 3, true)).toBe(5);
    expect(gamesCountAt + 1 + 4 + REPLAY_CHECKSUM_BYTES).toBe(n);
    // 第 0 条输入的 16 字节就是 InputEvent 布局：tick u32 小端在前。
    expect(v.getUint32(RP_INPUTS + IE_TICK, true)).toBe(fixtureJson.inputs[0]!.tick);
  });

  test('长度 = replayByteLength(输入, 哈希, 局数)', () => {
    expect(fixtureBytes.length).toBe(
      replayByteLength(fixtureJson.inputs.length, fixtureJson.hashes.length, fixtureJson.games.length),
    );
  });
});

describe('往返', () => {
  test('最短回放：125 字节', () => {
    const r = minimalReplay();
    const b = encodeReplay(r);
    expect(b.length).toBe(REPLAY_MIN_BYTES);
    expect(REPLAY_MIN_BYTES).toBe(125);
    expect(decodeReplay(b)).toEqual(r);
  });

  test('随机回放 300 例：encode → decode 相等，再 encode 字节相同', () => {
    const r = rand32(0xbadc0de);
    let withInputs = 0;
    for (let i = 0; i < 300; i++) {
      const rep = randomReplay(r);
      expect(validateReplay(rep)).toBeNull();
      const b = encodeReplay(rep);
      expect(b.length).toBe(replayByteLength(rep.inputs.length, rep.hashes.length, rep.games.length));
      const d = decodeReplay(b);
      expect(d).toEqual(rep);
      expect(encodeReplay(d)).toEqual(b);
      if (rep.inputs.length > 0) withInputs++;
    }
    expect(withInputs).toBeGreaterThan(50);
  });

  test('可从更大缓冲区的子视图解码', () => {
    const big = new Uint8Array(fixtureBytes.length + 37);
    big.set(fixtureBytes, 17);
    expect(decodeReplay(big.subarray(17, 17 + fixtureBytes.length))).toEqual(fixtureJson);
  });

  test('体积量级：11 分排位约 3.5 分钟、220 条输入 → 4–5 KB', () => {
    const ticks = 210 * 30;
    const bytes = replayByteLength(220, replayHashCount(ticks), 1);
    expect(bytes).toBeGreaterThan(4000);
    expect(bytes).toBeLessThan(5200);
  });
});

describe('解码拒绝损坏数据', () => {
  test('魔数不对 → magic', () => {
    const b = fixtureBytes.slice();
    b[3] = 0x51;
    expectReplayError(() => decodeReplay(b), 'magic', /BMRP/);
    expectReplayError(() => decodeReplay(new Uint8Array(200)), 'magic');
  });

  test('fmt ≠ 0 → fmt', () => {
    const b = fixtureBytes.slice();
    b[RP_FMT] = 1;
    expectReplayError(() => decodeReplay(b), 'fmt', /fmt = 1/);
    const b2 = fixtureBytes.slice();
    b2[RP_FMT + 1] = 1;
    expectReplayError(() => decodeReplay(reseal(b2)), 'fmt');
  });

  test('魔数与 fmt 之后的每个字节翻转（不重写校验）：计数字段 → length，其余 → checksum', () => {
    const n = fixtureBytes.length;
    const tailAt = RP_INPUTS + INPUT_EVENT_BYTES * fixtureJson.inputs.length;
    const gameCountAt = n - REPLAY_CHECKSUM_BYTES - 4 * fixtureJson.games.length - 1;
    const structural = new Set<number>([gameCountAt]);
    for (let k = 0; k < 4; k++) {
      structural.add(RP_INPUT_COUNT + k); // inputCount
      structural.add(tailAt + 4 + k); // hashCount
    }
    const got: [number, string][] = [];
    const want: [number, string][] = [];
    for (let i = RP_FMT + 2; i < n; i++) {
      const b = fixtureBytes.slice();
      b[i] ^= 0x10;
      let code = 'ok';
      try {
        decodeReplay(b);
      } catch (e) {
        code = e instanceof ReplayError ? e.code : 'other';
      }
      got.push([i, code]);
      want.push([i, structural.has(i) ? 'length' : 'checksum']);
    }
    expect(got).toEqual(want);
  });

  test('改尾部校验本身 → checksum', () => {
    const b = fixtureBytes.slice();
    b[b.length - 1] ^= 0xff;
    expectReplayError(() => decodeReplay(b), 'checksum', /校验不符/);
  });

  test('截断（各种长度）→ length', () => {
    const n = fixtureBytes.length;
    for (const len of [0, 1, 3, 4, 5, 7, 8, 50, REPLAY_MIN_BYTES - 1, REPLAY_MIN_BYTES, 300, n - 5, n - 4, n - 1]) {
      expectReplayError(() => decodeReplay(fixtureBytes.slice(0, len)), 'length');
    }
  });

  test('末尾多余字节 → length', () => {
    const b = new Uint8Array(fixtureBytes.length + 1);
    b.set(fixtureBytes);
    expectReplayError(() => decodeReplay(b), 'length', /多余/);
  });

  test('计数损坏（inputCount 巨大）→ length，且不先分配', () => {
    const b = fixtureBytes.slice();
    new DataView(b.buffer).setUint32(RP_INPUT_COUNT, 0xffffffff, true);
    expectReplayError(() => decodeReplay(b), 'length', /inputCount/);
  });

  test('保留字段非 0（校验已重写）→ field', () => {
    const b = fixtureBytes.slice();
    b[RP_RESERVED] = 1;
    expectReplayError(() => decodeReplay(reseal(b)), 'field', /保留/);
  });

  test('输入的 kind 非法 / 保留位非 0（校验已重写）→ field', () => {
    const b = fixtureBytes.slice();
    b[RP_INPUTS + 2 * INPUT_EVENT_BYTES + IE_KIND_PLAYER] = 0x00;
    expectReplayError(() => decodeReplay(reseal(b)), 'field', /第 2 条输入/);
    const b2 = fixtureBytes.slice();
    b2[RP_INPUTS + IE_KIND_PLAYER] |= 0x20;
    expectReplayError(() => decodeReplay(reseal(b2)), 'field', /保留位/);
  });

  test('输入属于 AI 球员（校验已重写）→ field', () => {
    const b = fixtureBytes.slice();
    b[RP_INPUTS + 3 * INPUT_EVENT_BYTES + IE_KIND_PLAYER] |= 0x80;
    expectReplayError(() => decodeReplay(reseal(b)), 'field', /AI/);
  });

  test('输入 tick 倒退（校验已重写）→ field', () => {
    const b = fixtureBytes.slice();
    new DataView(b.buffer).setUint32(RP_INPUTS + 5 * INPUT_EVENT_BYTES + IE_TICK, 0, true);
    expectReplayError(() => decodeReplay(reseal(b)), 'field', /单调不减/);
  });

  test('MatchCfg 非法（校验已重写）→ field', () => {
    const b = fixtureBytes.slice();
    new DataView(b.buffer).setInt32(RP_MATCH_CFG, 9, true);
    expectReplayError(() => decodeReplay(reseal(b)), 'field', /rulesId/);
  });

  test('哈希个数与 totalTicks 不符（校验已重写）→ field', () => {
    const b = fixtureBytes.slice();
    const tailAt = RP_INPUTS + INPUT_EVENT_BYTES * fixtureJson.inputs.length;
    new DataView(b.buffer).setUint32(tailAt, fixtureJson.totalTicks + REPLAY_HASH_EVERY_TICKS, true);
    expectReplayError(() => decodeReplay(reseal(b)), 'field', /哈希个数/);
  });
});

describe('编码拒绝非法回放', () => {
  const cases: [string, (r: Replay) => void, RegExp][] = [
    [
      'AI 球员的输入',
      (r) => {
        r.inputs[0]!.player = 1;
      },
      /AI/,
    ],
    [
      'tick 倒退',
      (r) => {
        r.inputs[1]!.tick = r.inputs[0]!.tick - 1;
      },
      /单调不减/,
    ],
    [
      '输入 tick ≥ totalTicks',
      (r) => {
        r.inputs[r.inputs.length - 1]!.tick = r.totalTicks;
      },
      /totalTicks/,
    ],
    [
      '输入字段越界',
      (r) => {
        r.inputs[0]!.offMs = -129;
      },
      /offMs/,
    ],
    ['哈希个数不符', (r) => r.hashes.pop(), /哈希个数/],
    ['哈希不是 u32', (r) => (r.hashes[0] = -1), /哈希/],
    ['比分超出 u16', (r) => (r.games[0] = [65536, 0]), /比分/],
    ['局数超过 255', (r) => (r.games = Array.from({ length: 256 }, () => [0, 0] as [number, number])), /局数/],
    ['simVer 不是 u32', (r) => (r.simVer = 2 ** 32), /simVer/],
    ['MatchCfg 非法', (r) => (r.cfg.rulesId = 0), /MatchCfg/],
    [
      '排位赛开 DDA',
      (r) => {
        r.cfg.rulesId = RULES_ID.RANKED11;
        r.cfg.ddaEnabled = 1;
      },
      /排位赛/,
    ],
  ];
  for (const [name, mutate, re] of cases) {
    test(`拒绝：${name}`, () => {
      const r = structuredClone(fixtureJson);
      mutate(r);
      expectReplayError(() => encodeReplay(r), 'field', re);
      expect(validateReplay(r)).toMatch(re);
    });
  }

  test('不是对象 / 输入项为 null：validateReplay 返回中文错误，encode 抛 ReplayError(field)', () => {
    expect(validateReplay(null as unknown as Replay)).toMatch(/回放必须是对象/);
    expectReplayError(() => encodeReplay(undefined as unknown as Replay), 'field', /回放必须是对象/);
    const r = structuredClone(fixtureJson);
    r.cfg = null as unknown as MatchCfg;
    expectReplayError(() => encodeReplay(r), 'field', /MatchCfg 必须是对象/);
    const r2 = structuredClone(fixtureJson);
    r2.inputs[3] = null as unknown as InputEvent;
    expectReplayError(() => encodeReplay(r2), 'field', /第 3 条输入/);
  });

  test('含 −0 的回放：encode 抛 ReplayError(field) 并提示 |0 归一；归一后 decode(encode(r)) 等于 r', () => {
    // 回归：输入 offMs、MatchCfg、哈希、比分里的 −0 曾能过校验，往返后成 +0，toEqual(r) 失败。
    const negZero = Math.round(-0.3);
    const cases: [string, (r: Replay) => void, RegExp][] = [
      ['输入 offMs', (r) => (r.inputs[0]!.offMs = negZero), /offMs/],
      ['输入 player', (r) => (r.inputs[0]!.player = negZero as 0), /player/],
      ['MatchCfg inputOffsetMs', (r) => (r.cfg.players[0].inputOffsetMs = negZero), /inputOffsetMs/],
      ['哈希', (r) => (r.hashes[0] = negZero), /哈希/],
      ['比分', (r) => (r.games[0]![1] = negZero), /比分/],
      ['contentHash', (r) => (r.contentHash = negZero), /contentHash/],
    ];
    for (const [name, mutate, re] of cases) {
      const r = structuredClone(fixtureJson);
      mutate(r);
      expect([name, validateReplay(r)]).toEqual([name, expect.stringMatching(re)]);
      expectReplayError(() => encodeReplay(r), 'field', /−0 不合法：量化结果请 \|0 归一/);
    }
    const r = structuredClone(fixtureJson);
    r.inputs[0]!.offMs = negZero | 0;
    r.hashes[0] = negZero >>> 0;
    expect(decodeReplay(encodeReplay(r))).toEqual(r);
  });

  test('两名都是人时，两名球员的输入都可以存', () => {
    const r = structuredClone(fixtureJson);
    r.cfg.players[1] = defaultPlayerCfg(PLAYER_KIND.HUMAN);
    r.inputs[0]!.player = 1;
    expect(decodeReplay(encodeReplay(r))).toEqual(r);
  });
});

describe('replayFnv1a', () => {
  test('与 sim 的 fnvBytes 在随机字节上相同；空区间为偏移基数', () => {
    const r = rand32(99);
    for (let n = 0; n < 200; n += 13) {
      const b = Uint8Array.from({ length: n }, () => r() & 0xff);
      expect(replayFnv1a(b, 0, n)).toBe(fnvBytes(b));
    }
    expect(replayFnv1a(new Uint8Array(0), 0, 0)).toBe(0x811c9dc5);
  });
});
