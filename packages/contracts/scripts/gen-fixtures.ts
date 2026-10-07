/**
 * 生成契约夹具（一次性；生成后提交，测试只读不写）。
 *
 *   bun packages/contracts/scripts/gen-fixtures.ts [--force]
 *
 * 产出（packages/contracts/fixtures/）：
 * - input-events.v0.json：若干 InputEvent（含各字段边界值）与其 16 字节十六进制；
 * - replay-v0.bmrp + replay-v0.json：同一份回放的二进制与 JSON；
 * - snapshot-layout.v<SNAPSHOT_SCHEMA_VER>.json（当前 v0）：快照布局基线（名字、偏移、count），"只许追加"测试对照它。
 *
 * 已存在的文件默认跳过；--force 覆盖前两类。布局基线永不覆盖：bump SNAPSHOT_SCHEMA_VER（例如冻结为 v1）
 * 后会写出新版本号的基线文件；同一版本号的基线要换，必须手工删除旧文件，让改动在评审里一目了然。
 *
 * 回放里的 simVer / contentHash / tablesHash / 哈希都是占位数（还没有对局模拟），只用于验证格式。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { INPUT_KIND, type InputEvent } from '../src/api';
import { INPUT_EVENT_BYTES, encodeInputEvent } from '../src/input-event';
import { PLAYER_KIND, RULES_ID, defaultPlayerCfg, type MatchCfg } from '../src/match-cfg';
import { encodeReplay, replayHashCount, type Replay } from '../src/replay';
import { SNAPSHOT_F64_LAYOUT, SNAPSHOT_I32_LAYOUT, SNAPSHOT_SCHEMA_VER, type SnapshotLayout } from '../src/snapshot.schema';

export const FIXTURES_DIR = resolve(import.meta.dir, '..', 'fixtures');

/** 十六进制（小写，无分隔）。 */
export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** 夹具里的命名 InputEvent：覆盖 tick 0 / 2^32−1、offMs −128 / 127、四种 kind、两名球员、i16 极值、durMs 0 / 65535。 */
export function sampleInputEvents(): { name: string; event: InputEvent }[] {
  return [
    {
      name: '全部取下界',
      event: { tick: 0, offMs: -128, player: 0, kind: INPUT_KIND.DOWN, tx: -32768, tz: -32768, dx: -32768, dy: -32768, durMs: 0 },
    },
    {
      name: '全部取上界',
      event: {
        tick: 4294967295,
        offMs: 127,
        player: 1,
        kind: INPUT_KIND.CANCEL,
        tx: 32767,
        tz: 32767,
        dx: 32767,
        dy: 32767,
        durMs: 65535,
      },
    },
    {
      name: '典型松手（杀球）',
      event: { tick: 1234, offMs: -17, player: 0, kind: INPUT_KIND.RELEASE, tx: 250, tz: -130, dx: 120, dy: -480, durMs: 180 },
    },
    {
      name: '预判走位',
      event: { tick: 30, offMs: 0, player: 1, kind: INPUT_KIND.PREMOVE, tx: -300, tz: 200, dx: 0, dy: 0, durMs: 0 },
    },
    {
      name: 'tick 跨过 2^31（u32 不是 i32）',
      event: { tick: 2147483648, offMs: -1, player: 1, kind: INPUT_KIND.DOWN, tx: -1, tz: 1, dx: -2, dy: 2, durMs: 256 },
    },
    {
      name: '全零之外的最小记录（kind 0 非法，DOWN = 1）',
      event: { tick: 0, offMs: 0, player: 0, kind: INPUT_KIND.DOWN, tx: 0, tz: 0, dx: 0, dy: 0, durMs: 0 },
    },
  ];
}

function encodeOne(ev: InputEvent): Uint8Array {
  const bytes = new Uint8Array(INPUT_EVENT_BYTES);
  encodeInputEvent(ev, new DataView(bytes.buffer), 0);
  return bytes;
}

/** 确定性的小 xorshift32（只给夹具造占位数据）。 */
function makeRand(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
}

/** 夹具回放：快速赛 7 分，人（新手窗口 1250‰、延迟校准 −40 ms）对 Lv5 AI；种子高位为 1（检验 u32）。 */
export function sampleReplay(): Replay {
  const cfg: MatchCfg = {
    rulesId: RULES_ID.QUICK7,
    seed: 0x9e3779b9,
    venueId: 2,
    ddaEnabled: 1,
    staminaEnabled: 1,
    abGroup: 3,
    players: [
      { ...defaultPlayerCfg(PLAYER_KIND.HUMAN), windowScalePermille: 1250, inputOffsetMs: -40 },
      { ...defaultPlayerCfg(PLAYER_KIND.AI, 5), runSpeedPermille: 900 },
    ],
  };
  const rand = makeRand(0x5eed);
  const totalTicks = 4321;
  const inputs: InputEvent[] = [];
  let tick = 12;
  const kinds = [INPUT_KIND.PREMOVE, INPUT_KIND.DOWN, INPUT_KIND.RELEASE] as const;
  for (let shot = 0; tick < totalTicks - 60 && inputs.length < 24; shot++) {
    for (const kind of kinds) {
      const r = rand();
      inputs.push({
        tick,
        offMs: 0 - (r % 34), // 0 − x 而非 −x：避免 −0
        player: 0,
        kind,
        tx: ((r >>> 8) % 1200) - 600,
        tz: ((r >>> 4) % 500) - 250,
        dx: kind === INPUT_KIND.RELEASE ? ((r >>> 12) % 1000) - 500 : 0,
        dy: kind === INPUT_KIND.RELEASE ? 0 - ((r >>> 16) % 900) : 0,
        durMs: kind === INPUT_KIND.RELEASE ? 80 + ((r >>> 20) % 400) : 0,
      });
      tick += kind === INPUT_KIND.RELEASE ? 120 + (r % 90) : 3 + (r % 12);
    }
  }
  // 同一 tick 两条（单调不减而非严格递增），外加一条 CANCEL。
  const last = inputs[inputs.length - 1]!;
  inputs.push({ ...last, kind: INPUT_KIND.CANCEL, offMs: -128, dx: 0, dy: 0, durMs: 0 });
  const hashes: number[] = [];
  for (let i = 0; i < replayHashCount(totalTicks); i++) hashes.push(rand());
  return {
    simVer: 0xa1b2c3d4,
    contentHash: 0x0badf00d,
    tablesHash: 0xfeedbeef,
    cfg,
    inputs,
    totalTicks,
    hashes,
    games: [[7, 5]],
  };
}

/** 布局基线（名字、偏移、count）。 */
export function layoutBaseline(): object {
  const strip = (l: SnapshotLayout) => l.slots.map((s) => ({ name: s.name, offset: s.offset, count: s.count }));
  return {
    comment: '快照布局基线（契约草案 v0）。只许追加：现有各项的名字、偏移、count 不得改变，新字段只能出现在两张表末尾。',
    schemaVer: SNAPSHOT_SCHEMA_VER,
    i32Len: SNAPSHOT_I32_LAYOUT.length,
    f64Len: SNAPSHOT_F64_LAYOUT.length,
    i32: strip(SNAPSHOT_I32_LAYOUT),
    f64: strip(SNAPSHOT_F64_LAYOUT),
  };
}

function writeIfAllowed(path: string, data: string | Uint8Array, force: boolean): void {
  const shown = relative(process.cwd(), path) || path;
  if (existsSync(path) && !force) {
    console.log(`跳过（已存在）：${shown}`);
    return;
  }
  writeFileSync(path, data);
  console.log(`已写出：${shown}`);
}

function main(argv: string[]): number {
  const force = argv.includes('--force');
  for (const a of argv) {
    if (a !== '--force') {
      console.error(`gen-fixtures：未知参数 ${a}（用法：bun packages/contracts/scripts/gen-fixtures.ts [--force]）`);
      return 2;
    }
  }
  mkdirSync(FIXTURES_DIR, { recursive: true });

  const events = sampleInputEvents().map(({ name, event }) => ({ name, event, hex: toHex(encodeOne(event)) }));
  const eventsJson = {
    comment: 'InputEvent 16 字节小端布局的黄金样例（契约草案 v0）。hex 为编码后的 16 字节。',
    bytesPerEvent: INPUT_EVENT_BYTES,
    events,
  };
  writeIfAllowed(resolve(FIXTURES_DIR, 'input-events.v0.json'), JSON.stringify(eventsJson, null, 2) + '\n', force);

  const replay = sampleReplay();
  const bytes = encodeReplay(replay);
  const replayJson = {
    comment: `与 replay-v0.bmrp 同一份内容（BMRP fmt 0，${bytes.length} 字节）。simVer、contentHash、tablesHash 与哈希均为占位数。`,
    replay,
  };
  writeIfAllowed(resolve(FIXTURES_DIR, 'replay-v0.bmrp'), bytes, force);
  writeIfAllowed(resolve(FIXTURES_DIR, 'replay-v0.json'), JSON.stringify(replayJson, null, 2) + '\n', force);

  // 文件名随 SNAPSHOT_SCHEMA_VER（测试按同一规则找基线）；已存在则永不覆盖。
  writeIfAllowed(
    resolve(FIXTURES_DIR, `snapshot-layout.v${SNAPSHOT_SCHEMA_VER}.json`),
    JSON.stringify(layoutBaseline(), null, 2) + '\n',
    false,
  );
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
