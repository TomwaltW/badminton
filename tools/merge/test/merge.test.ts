/**
 * bun run merge 的集成测试：在 os.tmpdir() 里建临时 git 仓库，package.json 的 gate 脚本是读标志文件决定退出码的
 * 小 sh 脚本；用 git worktree add .worktrees/task-t1 -b track/t1 建轨道。gate 命令用默认的 bun run gate。
 * 每个场景都断言回执 review/receipt-t1.md 的内容。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  OUTCOME_EXIT,
  OUTCOME_TEXT,
  fenceFor,
  formatTime,
  parseWorktreeList,
  renderReceipt,
  runMerge,
  type MergeOptions,
  type MergeReport,
} from '../merge';
import { HAS_GIT, Sandbox, commitAll, git, gitRaw, initRepo, put } from './sandbox';

const MERGE_TS = resolve(import.meta.dir, '..', 'merge.ts');

/**
 * 假 gate：noisy.flag → 先打印 300 行；gate-red → 红；a.flag 与 b.flag 同时存在 → 红（模拟"两边各自绿、合起来红"）；
 * 以下只在主干运行时生效：sigint.flag → 向自己的进程组发 SIGINT（模拟终端里按 Ctrl-C）；hup.flag → 发 SIGHUP
 * （模拟关终端 / SSH 断线）；kill9.flag → 发 SIGKILL（模拟 kill -9，merge 来不及收尾）。
 */
const GATE_SH = `#!/bin/sh
# 假 gate：读标志文件决定退出码
here=$(basename "$(pwd)")
echo "假 gate 开始：$here"
if [ -n "$GATE_LOG" ]; then echo "gate:$here" >> "$GATE_LOG"; fi
if [ -f sigint.flag ] && [ "$here" != task-t1 ]; then echo "模拟 Ctrl-C"; kill -INT 0; sleep 5; echo "没被中断"; fi
if [ -f hup.flag ] && [ "$here" != task-t1 ]; then echo "模拟关终端"; kill -HUP 0; sleep 5; echo "没被中断"; fi
if [ -f kill9.flag ] && [ "$here" != task-t1 ]; then echo "模拟 kill -9"; kill -KILL 0; sleep 5; echo "没被杀掉"; fi
if [ -f noisy.flag ]; then i=1; while [ $i -le 300 ]; do echo "噪声第 $i 行"; i=$((i+1)); done; fi
if [ -f gate-red ]; then echo "标志 gate-red 存在 → 红"; exit 1; fi
if [ -f a.flag ] && [ -f b.flag ]; then echo "a.flag 与 b.flag 同时存在 → 红"; exit 7; fi
echo "假 gate：绿"
`;

let sb: Sandbox;
beforeAll(() => {
  sb = new Sandbox('merge-test');
  sb.isolate();
});
afterAll(() => sb.cleanup());

interface Fixture {
  root: string;
  wt: string;
  log: string;
  base: string;
}

let seq = 0;
/** 新建一个带轨道工作树的临时仓库。 */
function setup(): Fixture {
  const name = `repo${++seq}`;
  const root = initRepo(sb.dir(name));
  put(root, '.gitignore', '.worktrees/\nnode_modules/\n');
  put(root, 'package.json', `${JSON.stringify({ name: 'merge-sandbox', private: true, scripts: { gate: 'sh ./gate.sh' } }, null, 2)}\n`);
  put(root, 'gate.sh', GATE_SH);
  put(root, 'shared.txt', '第一行\n第二行\n');
  const base = commitAll(root, '初始');
  git(root, 'worktree', 'add', '-q', '.worktrees/task-t1', '-b', 'track/t1');
  return { root, wt: join(root, '.worktrees', 'task-t1'), log: join(sb.base, `${name}-gate.log`), base };
}

function merge(f: Fixture, extra: Partial<MergeOptions> = {}): Promise<MergeReport> {
  return runMerge({
    track: 't1',
    cwd: f.root,
    echo: false,
    write: () => {},
    env: { ...process.env, GATE_LOG: f.log },
    ...extra,
  });
}

function receipt(f: Fixture): string {
  const p = join(f.root, 'review', 'receipt-t1.md');
  expect(existsSync(p)).toBe(true);
  return readFileSync(p, 'utf8');
}

function gateLog(f: Fixture): string[] {
  return existsSync(f.log) ? readFileSync(f.log, 'utf8').split('\n').filter((l) => l.length > 0) : [];
}

const head = (dir: string) => git(dir, 'rev-parse', 'HEAD');
const trackedDirty = (dir: string) => git(dir, 'status', '--porcelain', '--untracked-files=no');

describe.skipIf(!HAS_GIT)('bun run merge（临时 git 仓库）', () => {
  test('工作树 gate 绿 + 主干 gate 绿 → --no-ff 合并提交，回执"已合并"', async () => {
    const f = setup();
    put(f.wt, 'feature.txt', '新功能\n');
    const branchSha = commitAll(f.wt, '轨道：新功能');
    const t0 = new Date(2026, 9, 8, 9, 30, 0);

    const r = await merge(f, { now: () => t0 });
    expect(r.outcome).toBe('merged');
    expect(r.exitCode).toBe(0);
    expect(r.preSha).toBe(f.base);
    expect(r.branch).toBe('track/t1');

    const mergeSha = head(f.root);
    expect(r.mergeSha).toBe(mergeSha);
    expect(r.finalSha).toBe(mergeSha);
    // --no-ff：合并提交有两个父提交（即使可以快进）
    expect(git(f.root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toEqual([mergeSha, f.base, branchSha]);
    expect(git(f.root, 'log', '-1', '--format=%s')).toBe('合并 t1（track/t1）');
    expect(existsSync(join(f.root, 'feature.txt'))).toBe(true);
    expect(trackedDirty(f.root)).toBe('');
    // gate 先在轨道工作树跑，再在主干跑；默认命令是 bun run gate
    expect(gateLog(f)).toEqual(['gate:task-t1', `gate:${basename(f.root)}`]);
    expect(r.worktreeGate?.cmd.slice(1)).toEqual(['run', 'gate']);

    const text = receipt(f);
    expect(text).toContain('# 合并回执：t1');
    expect(text).toContain(`**${OUTCOME_TEXT.merged}**（退出码 0）`);
    expect(text).toContain('已合并');
    expect(text).toContain(`| 分支 | \`track/t1\` @ \`${branchSha}\` |`);
    expect(text).toContain(`| 主干 | \`main\` |`);
    expect(text).toContain(`| 合并前 sha | \`${f.base}\` |`);
    expect(text).toContain(`| 合并后 sha | \`${mergeSha}\`（合并提交） |`);
    expect(text).toContain(`| 开始 | ${formatTime(t0)} |`);
    expect(text).toContain('| 工作树 gate | 退出码 0');
    expect(text).toContain('| 主干 gate | 退出码 0');
    expect(text).toContain('## 工作树 gate 输出');
    expect(text).toContain('## 主干 gate 输出');
    expect(text).toContain('假 gate 开始：task-t1');
    expect(text).toContain('假 gate：绿');
    expect(text).toContain('工作树依赖安装：跳过（没有 bun.lock）');
  });

  test('工作树 gate 红 → 不合并，主干 sha 不变；回执"未合并（工作树 gate 红）"，输出截断到最后 200 行', async () => {
    const f = setup();
    put(f.wt, 'feature.txt', '新功能\n');
    commitAll(f.wt, '轨道：新功能');
    put(f.wt, 'gate-red', ''); // 未跟踪的标志文件不影响"已跟踪文件干净"
    put(f.wt, 'noisy.flag', '');

    const r = await merge(f);
    expect(r.outcome).toBe('worktree-red');
    expect(r.exitCode).toBe(OUTCOME_EXIT['worktree-red']);
    expect(r.exitCode).not.toBe(0);
    expect(head(f.root)).toBe(f.base);
    expect(existsSync(join(f.root, 'feature.txt'))).toBe(false);
    expect(gateLog(f)).toEqual(['gate:task-t1']);
    expect(r.mainGate).toBeNull();

    const text = receipt(f);
    expect(text).toContain('**未合并（工作树 gate 红）**');
    expect(text).toContain('| 工作树 gate | 退出码 1');
    expect(text).toContain('| 主干 gate | 未运行 |');
    expect(text).toContain('| 合并后 sha | —（没有产生合并提交） |');
    expect(text).toContain(`| 结束时主干 sha | \`${f.base}\` |`);
    expect(text).toContain('标志 gate-red 存在 → 红');
    // 输出 300 多行（bun run 的命令回显 + 假 gate 的 302 行 + bun 的退出说明），回执只留最后 200 行
    const m = /共 (\d+) 行，以下为最后 200 行。\n\n```text\n([\s\S]*?)\n```/.exec(text);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(302);
    const kept = m![2]!.split('\n');
    expect(kept.length).toBe(200);
    expect(kept).toContain('噪声第 300 行');
    expect(kept).not.toContain('噪声第 1 行');
    expect(kept).not.toContain('假 gate 开始：task-t1');
  });

  test('主干 gate 红（两边各自绿、合并后标志文件凑齐）→ git reset --keep 回到合并前 sha；回执"已回退（主干 gate 红）"', async () => {
    const f = setup();
    put(f.root, 'a.flag', '主干的标志\n');
    const pre = commitAll(f.root, '主干：a.flag');
    put(f.wt, 'b.flag', '轨道的标志\n');
    commitAll(f.wt, '轨道：b.flag');

    const r = await merge(f);
    expect(r.outcome).toBe('reverted');
    expect(r.exitCode).toBe(OUTCOME_EXIT.reverted);
    expect(r.preSha).toBe(pre);
    expect(r.mergeSha).not.toBeNull();
    expect(r.mergeSha).not.toBe(pre);
    expect(head(f.root)).toBe(pre);
    expect(trackedDirty(f.root)).toBe('');
    expect(existsSync(join(f.root, 'b.flag'))).toBe(false);
    // 合并提交确实产生过（只是已不在主干上）
    expect(git(f.root, 'cat-file', '-t', r.mergeSha!)).toBe('commit');
    expect(gitRaw(f.root, 'merge-base', '--is-ancestor', r.mergeSha!, 'HEAD').status).toBe(1);
    expect(gateLog(f)).toEqual(['gate:task-t1', `gate:${basename(f.root)}`]);

    const text = receipt(f);
    expect(text).toContain('**已回退（主干 gate 红）**');
    expect(text).toContain(`| 合并前 sha | \`${pre}\` |`);
    expect(text).toContain(`| 合并后 sha | \`${r.mergeSha}\`（合并提交，已回退） |`);
    expect(text).toContain(`| 结束时主干 sha | \`${pre}\` |`);
    expect(text).toContain('| 工作树 gate | 退出码 0');
    expect(text).toContain('| 主干 gate | 退出码 7');
    expect(text).toContain('a.flag 与 b.flag 同时存在 → 红');
    expect(text).toContain(`已执行 git reset --keep ${pre}`);
    expect(text).not.toContain('reset --hard');
  });

  test('两边改同一行 → 冲突，git merge --abort，主干干净；回执"冲突已中止"', async () => {
    const f = setup();
    put(f.root, 'shared.txt', '主干改的第一行\n第二行\n');
    const pre = commitAll(f.root, '主干：改第一行');
    put(f.wt, 'shared.txt', '轨道改的第一行\n第二行\n');
    commitAll(f.wt, '轨道：改第一行');

    const r = await merge(f);
    expect(r.outcome).toBe('conflict');
    expect(r.exitCode).toBe(OUTCOME_EXIT.conflict);
    expect(head(f.root)).toBe(pre);
    expect(trackedDirty(f.root)).toBe('');
    expect(gitRaw(f.root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').status).not.toBe(0);
    expect(readFileSync(join(f.root, 'shared.txt'), 'utf8')).toBe('主干改的第一行\n第二行\n');
    expect(r.conflicts).toEqual(['shared.txt']);
    expect(gateLog(f)).toEqual(['gate:task-t1']);

    const text = receipt(f);
    expect(text).toContain('**冲突已中止**');
    expect(text).toContain('## 冲突文件');
    expect(text).toContain('- `shared.txt`');
    expect(text).toContain('已执行 git merge --abort');
    expect(text).toContain('| 主干 gate | 未运行 |');
    expect(text).toContain(`| 结束时主干 sha | \`${pre}\` |`);
  });

  test('主干有未提交的已跟踪改动 → 拒绝执行，不跑 gate、不动主干', async () => {
    const f = setup();
    put(f.wt, 'feature.txt', '新功能\n');
    commitAll(f.wt, '轨道：新功能');
    put(f.root, 'shared.txt', '没提交的改动\n');

    const r = await merge(f);
    expect(r.outcome).toBe('refused');
    expect(r.exitCode).toBe(OUTCOME_EXIT.refused);
    expect(head(f.root)).toBe(f.base);
    expect(readFileSync(join(f.root, 'shared.txt'), 'utf8')).toBe('没提交的改动\n');
    expect(gateLog(f)).toEqual([]);

    const text = receipt(f);
    expect(text).toContain('**拒绝执行（前置检查未通过）**');
    expect(text).toContain('主干有未提交的已跟踪改动');
    expect(text).toContain('M shared.txt');
    expect(text).toContain('| 工作树 gate | 未运行 |');
  });

  test('轨道工作树有未提交的已跟踪改动 → 拒绝执行', async () => {
    const f = setup();
    put(f.wt, 'feature.txt', '新功能\n');
    commitAll(f.wt, '轨道：新功能');
    put(f.wt, 'shared.txt', '轨道没提交的改动\n');

    const r = await merge(f);
    expect(r.outcome).toBe('refused');
    expect(head(f.root)).toBe(f.base);
    expect(gateLog(f)).toEqual([]);
    expect(receipt(f)).toContain('轨道工作树 .worktrees/task-t1 有未提交的已跟踪改动');
  });

  test('在链接工作树里运行 → 拒绝执行（回执仍写到主工作树的 review/）', async () => {
    const f = setup();
    put(f.wt, 'feature.txt', '新功能\n');
    commitAll(f.wt, '轨道：新功能');

    const r = await merge(f, { cwd: f.wt });
    expect(r.outcome).toBe('refused');
    expect(r.reason).toContain('必须在主工作树里运行');
    expect(head(f.root)).toBe(f.base);
    expect(existsSync(join(f.wt, 'review'))).toBe(false);
    expect(receipt(f)).toContain('必须在主工作树里运行');
  });

  test('.worktrees/task-<轨> 只是普通目录、不是本仓库的工作树 → 拒绝执行', async () => {
    const f = setup();
    mkdirSync(join(f.root, '.worktrees', 'task-t2'), { recursive: true });
    const r = await merge(f, { track: 't2' });
    expect(r.outcome).toBe('refused');
    expect(r.reason).toContain('不是本仓库的工作树');
    const text = readFileSync(join(f.root, 'review', 'receipt-t2.md'), 'utf8');
    expect(text).toContain('# 合并回执：t2');
    expect(text).toContain('拒绝执行');
  });

  test('轨道分支没有新提交 → 拒绝执行（无需合并）', async () => {
    const f = setup();
    const r = await merge(f);
    expect(r.outcome).toBe('refused');
    expect(r.reason).toContain('无需合并');
    expect(gateLog(f)).toEqual([]);
  });

  test('轨道名不合法 → 拒绝执行，不写回执', async () => {
    const f = setup();
    const r = await merge(f, { track: '../evil' });
    expect(r.outcome).toBe('refused');
    expect(r.receiptPath).toBeNull();
    expect(existsSync(join(f.root, 'review'))).toBe(false);
  });

  test('有 bun.lock 时先安装依赖；合并改了 bun.lock 时主干也先安装（install / gate 命令可注入）', async () => {
    const f = setup();
    put(f.wt, 'bun.lock', '{}\n');
    put(f.wt, 'feature.txt', '新功能\n');
    commitAll(f.wt, '轨道：加依赖');
    const install = ['sh', '-c', 'echo "install:$(basename "$(pwd)")" >> "$GATE_LOG"'];
    const gate = ['sh', '-c', 'echo "injected:$(basename "$(pwd)")" >> "$GATE_LOG"; echo 注入的 gate'];

    const r = await merge(f, { installCmd: install, gateCmd: gate });
    expect(r.outcome).toBe('merged');
    const me = basename(f.root);
    expect(gateLog(f)).toEqual(['install:task-t1', 'injected:task-t1', `install:${me}`, `injected:${me}`]);
    const text = receipt(f);
    expect(text).toContain('## 工作树依赖安装 输出');
    expect(text).toContain('## 主干依赖安装（合并改了 bun.lock） 输出');
    expect(text).toContain('注入的 gate');
  });

  test('依赖安装失败 → 不跑 gate、不合并', async () => {
    const f = setup();
    put(f.wt, 'bun.lock', '{}\n');
    commitAll(f.wt, '轨道：加依赖');
    const r = await merge(f, { installCmd: ['sh', '-c', 'echo 锁文件不匹配; exit 1'] });
    expect(r.outcome).toBe('worktree-red');
    expect(r.worktreeGate).toBeNull();
    expect(head(f.root)).toBe(f.base);
    expect(gateLog(f)).toEqual([]);
    expect(receipt(f)).toContain('锁文件不匹配');
  });

  test('命令行：bun merge.ts t1 在主工作树里跑通并写回执；参数错误退出 2', () => {
    const f = setup();
    put(f.wt, 'feature.txt', '新功能\n');
    commitAll(f.wt, '轨道：新功能');
    const env = { ...process.env, GATE_LOG: f.log };
    const ok = spawnSync(process.execPath, [MERGE_TS, 't1', '--quiet'], { cwd: f.root, env, encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('结论：已合并');
    expect(receipt(f)).toContain('**已合并**');

    const none = spawnSync(process.execPath, [MERGE_TS], { cwd: f.root, env, encoding: 'utf8' });
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('用法：bun run merge <轨>');
    const help = spawnSync(process.execPath, [MERGE_TS, '--help'], { cwd: f.root, env, encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('退出码');
  });

  // ── 并发与中断：主干上可能同时有 INT 会话在工作；回退绝不能抹掉别人的提交或未提交的改动 ──

  /** 注入的 gate：在轨道工作树里运行时执行 inWt，在主干运行时执行 inMain（sh 片段）。 */
  const sideGate = (inWt: string, inMain: string) => [
    'sh',
    '-c',
    `if [ "$(basename "$(pwd)")" = task-t1 ]; then ${inWt || ':'}; else ${inMain || ':'}; fi`,
  ];

  for (const [name, inWt, expectHeadMoved] of [
    ['主干被提交', 'cd "$MAIN_ROOT" && echo 并发 > concurrent.txt && git add concurrent.txt && git commit -q --no-verify -m 并发提交', true],
    ['主干被改脏', 'cd "$MAIN_ROOT" && echo 没提交的编辑 >> shared.txt', false],
  ] as const) {
    test(`工作树 gate 期间${name} → 不合并（拒绝），主干上别人的工作原样保留`, async () => {
      const f = setup();
      put(f.wt, 'feature.txt', '新功能\n');
      commitAll(f.wt, '轨道：新功能');
      const r = await merge(f, { gateCmd: sideGate(inWt, ''), env: { ...process.env, GATE_LOG: f.log, MAIN_ROOT: f.root } });
      expect(r.outcome).toBe('refused');
      expect(r.reason).toContain('工作树 gate 期间主干发生了变化');
      expect(r.mergeSha).toBeNull();
      expect(existsSync(join(f.root, 'feature.txt'))).toBe(false);
      if (expectHeadMoved) {
        expect(git(f.root, 'log', '-1', '--format=%s')).toBe('并发提交');
        expect(git(f.root, 'rev-parse', 'HEAD^')).toBe(f.base);
      } else {
        expect(head(f.root)).toBe(f.base);
        expect(readFileSync(join(f.root, 'shared.txt'), 'utf8')).toBe('第一行\n第二行\n没提交的编辑\n');
      }
      const text = receipt(f);
      expect(text).toContain('**拒绝执行（前置检查未通过）**');
      expect(text).toContain('工作树 gate 期间主干发生了变化');
      expect(text).toContain('| 主干 gate | 未运行 |');
    });
  }

  test('主干 gate 红且其间主干出现未提交改动 → 用 git reset --keep 回退，改动保留', async () => {
    const f = setup();
    put(f.wt, 'feature.txt', '新功能\n');
    commitAll(f.wt, '轨道：新功能');
    const r = await merge(f, { gateCmd: sideGate('', 'echo 没提交的编辑 >> shared.txt; echo 主干 gate 红; exit 1') });
    expect(r.outcome).toBe('reverted');
    expect(head(f.root)).toBe(f.base);
    expect(existsSync(join(f.root, 'feature.txt'))).toBe(false);
    expect(readFileSync(join(f.root, 'shared.txt'), 'utf8')).toBe('第一行\n第二行\n没提交的编辑\n');
    const text = receipt(f);
    expect(text).toContain('**已回退（主干 gate 红）**');
    expect(text).toContain(`已执行 git reset --keep ${f.base}`);
    expect(text).toContain('git reset --keep 回退时保留它们');
  });

  test('主干 gate 期间在被合并删除的路径上新建了未跟踪文件 → reset --keep 拒绝覆盖，转"需手工处理"，文件原样保留', async () => {
    const f = setup();
    // old.txt 在主干与轨道上都有；轨道 git rm 它并提交，合并后主干上也没了
    put(f.root, 'old.txt', '旧内容\n');
    const pre = commitAll(f.root, '主干：old.txt');
    git(f.wt, 'merge', '-q', '--ff-only', 'main');
    git(f.wt, 'rm', '-q', 'old.txt');
    commitAll(f.wt, '轨道：删 old.txt');
    // 主干 gate 期间，有人在 old.txt 这个路径上写了新内容（未跟踪），然后 gate 红
    const r = await merge(f, { gateCmd: sideGate('', 'echo 用户内容 > old.txt; exit 1') });
    expect(r.outcome).toBe('revert-failed');
    expect(r.exitCode).toBe(OUTCOME_EXIT['revert-failed']);
    expect(readFileSync(join(f.root, 'old.txt'), 'utf8')).toBe('用户内容\n'); // 没被静默还原成旧内容
    expect(head(f.root)).toBe(r.mergeSha!);
    expect(r.finalSha).toBe(r.mergeSha);
    expect(r.warnings.join('\n')).toContain('old.txt');
    const text = receipt(f);
    expect(text).toContain(`**${OUTCOME_TEXT['revert-failed']}**（退出码 7）`);
    expect(text).toContain(`git reset --keep ${pre} 失败`);
    expect(text).toContain('old.txt');
    expect(text).toContain('挪走');
    expect(text).toContain(`git reset --keep ${pre}`);
    expect(text).toContain(`git revert -m 1 ${r.mergeSha}`);
    expect(text).not.toContain('reset --hard');
    // 照回执的提示：把挡路的文件挪走后再 reset --keep，主干回到合并前
    git(f.root, 'stash', 'push', '-q', '--include-untracked', '--', 'old.txt');
    git(f.root, 'reset', '--keep', pre);
    expect(head(f.root)).toBe(pre);
  });

  test('主干 gate 红但其间主干又有新提交 → 不自动回退（需手工处理），新提交保留', async () => {
    const f = setup();
    put(f.wt, 'feature.txt', '新功能\n');
    commitAll(f.wt, '轨道：新功能');
    const late = 'echo 晚到 > late.txt && git add late.txt && git commit -q --no-verify -m 晚到的提交; exit 1';
    const r = await merge(f, { gateCmd: sideGate('', late) });
    expect(r.outcome).toBe('revert-failed');
    expect(r.exitCode).toBe(OUTCOME_EXIT['revert-failed']);
    expect(git(f.root, 'log', '-1', '--format=%s')).toBe('晚到的提交');
    expect(git(f.root, 'rev-parse', 'HEAD^')).toBe(r.mergeSha!);
    expect(r.finalSha).toBe(head(f.root));
    const text = receipt(f);
    expect(text).toContain(`**${OUTCOME_TEXT['revert-failed']}**（退出码 7）`);
    expect(text).toContain(`git revert -m 1 ${r.mergeSha}`);
    expect(text).toContain(`| 合并后 sha | \`${r.mergeSha}\`（合并提交，未能自动回退，仍在主干上） |`);
  });

  test('已中断（注入）：工作树 gate 结束时已收到信号 → 不合并、不跑主干 gate', async () => {
    const f = setup();
    put(f.wt, 'feature.txt', '新功能\n');
    commitAll(f.wt, '轨道：新功能');
    const r = await merge(f, { interrupted: () => 'SIGINT' });
    expect(r.outcome).toBe('interrupted');
    expect(r.exitCode).toBe(OUTCOME_EXIT.interrupted);
    expect(head(f.root)).toBe(f.base);
    expect(gateLog(f)).toEqual(['gate:task-t1']);
    const text = receipt(f);
    expect(text).toContain('**已中断（未合并）**');
    expect(text).toContain('收到 SIGINT');
  });

  test('已中断（注入）：合并之后、主干 gate 之前收到信号 → 不跑主干 gate，回退', async () => {
    const f = setup();
    put(f.wt, 'feature.txt', '新功能\n');
    commitAll(f.wt, '轨道：新功能');
    let calls = 0;
    const r = await merge(f, { interrupted: () => (++calls === 1 ? null : 'SIGTERM') });
    expect(r.outcome).toBe('interrupted');
    expect(r.mergeSha).not.toBeNull();
    expect(r.mainGate).toBeNull();
    expect(head(f.root)).toBe(f.base);
    expect(existsSync(join(f.root, 'feature.txt'))).toBe(false);
    expect(gateLog(f)).toEqual(['gate:task-t1']);
    const text = receipt(f);
    expect(text).toContain('合并后收到 SIGTERM，没有跑主干 gate，已回退到合并前');
    expect(text).toContain('| 主干 gate | 未运行 |');
  });

  test('命令行：主干 gate 期间按 Ctrl-C（SIGINT 发给整个进程组）→ 回退并写回执，不停在未经 gate 的合并上', async () => {
    const f = setup();
    put(f.wt, 'sigint.flag', '');
    commitAll(f.wt, '轨道：sigint.flag');
    // detached：merge 自成一个进程组（相当于终端的前台进程组），假 gate 用 kill -INT 0 向这个组发信号
    const child = spawn(process.execPath, [MERGE_TS, 't1', '--quiet'], {
      cwd: f.root,
      env: { ...process.env, GATE_LOG: f.log },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout!.on('data', (d) => void (out += String(d)));
    child.stderr!.on('data', (d) => void (out += String(d)));
    const code = await new Promise<number | null>((res) => child.on('close', (c) => res(c)));
    expect(out).toContain('收到 SIGINT');
    expect(code).toBe(OUTCOME_EXIT.interrupted);
    expect(head(f.root)).toBe(f.base);
    expect(trackedDirty(f.root)).toBe('');
    expect(existsSync(join(f.root, 'sigint.flag'))).toBe(false);
    const text = receipt(f);
    expect(text).toContain('**已中断（未合并）**');
    expect(text).toContain('（收到 SIGINT），已回退到合并前');
    expect(text).toContain('（合并提交，已回退）');
    expect(text).not.toContain('没被中断');
  });

  // 关终端 / SSH 断线：SIGHUP 发给整个前台进程组，终端随即消失（写 stdout / stderr 失败）
  for (const closed of [false, true]) {
    test(`命令行：主干 gate 期间收到 SIGHUP${closed ? '，且输出管道已关闭' : ''} → 回退并写回执`, async () => {
      const f = setup();
      put(f.wt, 'hup.flag', '');
      commitAll(f.wt, '轨道：hup.flag');
      const child = spawn(process.execPath, [MERGE_TS, 't1'], {
        cwd: f.root,
        env: { ...process.env, GATE_LOG: f.log },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      if (closed) {
        // 模拟终端已关闭：读端一关，merge 之后的每次写输出都会 EPIPE
        child.stdout!.destroy();
        child.stderr!.destroy();
      } else {
        child.stdout!.on('data', (d) => void (out += String(d)));
        child.stderr!.on('data', (d) => void (out += String(d)));
      }
      const [code, signal] = await new Promise<[number | null, string | null]>((res) => child.on('close', (c, sg) => res([c, sg])));
      expect(signal).toBeNull();
      expect(code).toBe(OUTCOME_EXIT.interrupted);
      if (!closed) expect(out).toContain('收到 SIGHUP');
      expect(head(f.root)).toBe(f.base);
      expect(trackedDirty(f.root)).toBe('');
      expect(existsSync(join(f.root, 'hup.flag'))).toBe(false);
      const text = receipt(f);
      expect(text).toContain('**已中断（未合并）**');
      expect(text).toContain('（收到 SIGHUP），已回退到合并前');
      expect(text).not.toContain('没被中断');
    });
  }

  test('git merge 之前先写"进行中"回执（含检查与手工回退命令），正常结束时被最终结论覆盖', async () => {
    const f = setup();
    put(f.wt, 'feature.txt', '新功能\n');
    commitAll(f.wt, '轨道：新功能');
    const snap = join(sb.base, `snap-${seq}.md`);
    // 主干 gate 运行时（已合并、尚未有结论）把当时的回执拷出来
    const r = await merge(f, {
      gateCmd: sideGate('', 'cp review/receipt-t1.md "$SNAP"'),
      env: { ...process.env, GATE_LOG: f.log, SNAP: snap },
    });
    expect(r.outcome).toBe('merged');
    expect(existsSync(snap)).toBe(true);
    const during = readFileSync(snap, 'utf8');
    expect(during).toContain('# 合并回执：t1');
    expect(during).toContain('| 结论 | **进行中**');
    expect(during).toContain('主干可能停在未经 gate 的合并提交上');
    expect(during).toContain(`| 合并前 sha | \`${f.base}\` |`);
    expect(during).toContain('合并 t1（track/t1）');
    expect(during).toContain(`git reset --keep ${f.base}`);
    expect(during).toContain('git revert -m 1');
    expect(during).toContain('git merge --abort');
    expect(during).toContain('| 工作树 gate | 退出码 0');
    const text = receipt(f);
    expect(text).toContain(`**${OUTCOME_TEXT.merged}**（退出码 0）`);
    expect(text).not.toContain('**进行中**');
  });

  test('命令行：主干 gate 期间 merge 被 kill -9 → 回执停在"进行中"，照其中的命令手工回退', async () => {
    const f = setup();
    put(f.wt, 'kill9.flag', '');
    commitAll(f.wt, '轨道：kill9.flag');
    const child = spawn(process.execPath, [MERGE_TS, 't1', '--quiet'], {
      cwd: f.root,
      env: { ...process.env, GATE_LOG: f.log },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.resume();
    child.stderr!.resume();
    const signal = await new Promise<string | null>((res) => child.on('close', (_c, sg) => res(sg)));
    expect(signal).toBe('SIGKILL');
    // 主干停在未经 gate 的合并提交上
    expect(git(f.root, 'log', '-1', '--format=%s')).toBe('合并 t1（track/t1）');
    expect(git(f.root, 'rev-parse', 'HEAD^1')).toBe(f.base);
    const text = receipt(f);
    expect(text).toContain('| 结论 | **进行中**');
    expect(text).toContain('主干可能停在未经 gate 的合并提交上');
    expect(text).toContain(`git reset --keep ${f.base}`);
    expect(text).not.toContain('没被杀掉');
    git(f.root, 'reset', '--keep', f.base);
    expect(head(f.root)).toBe(f.base);
    expect(existsSync(join(f.root, 'kill9.flag'))).toBe(false);
  });
});

describe('解析与回执排版', () => {
  test('parseWorktreeList：主工作树、分支、分离 HEAD、prunable', () => {
    const list = parseWorktreeList(
      [
        'worktree /repo',
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/main',
        '',
        'worktree /repo/.worktrees/task-t1',
        'HEAD 2222222222222222222222222222222222222222',
        'branch refs/heads/track/t1',
        'locked 手工锁定',
        '',
        'worktree /repo/.worktrees/task-t2',
        'HEAD 3333333333333333333333333333333333333333',
        'detached',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n'),
    );
    expect(list.map((e) => e.path)).toEqual(['/repo', '/repo/.worktrees/task-t1', '/repo/.worktrees/task-t2']);
    expect(list[0]!.branch).toBe('refs/heads/main');
    expect(list[1]!.branch).toBe('refs/heads/track/t1');
    expect(list[1]!.locked).toBe(true);
    expect(list[2]!.branch).toBeNull();
    expect(list[2]!.detached).toBe(true);
    expect(list[2]!.prunable).toBe(true);
  });

  test('fenceFor：围栏比内容里最长的反引号串长', () => {
    expect(fenceFor('普通输出')).toBe('```');
    expect(fenceFor('里面有 ``` 围栏')).toBe('````');
    expect(fenceFor('`````')).toBe('``````');
  });

  test('formatTime：本地时间带时区偏移', () => {
    expect(formatTime(new Date(2026, 9, 8, 7, 5, 9))).toMatch(/^2026-10-08 07:05:09 [+-]\d\d:\d\d$/);
  });

  test('renderReceipt：输出里含反引号围栏也不会破坏 Markdown', () => {
    const d = new Date(2026, 9, 8, 7, 5, 9);
    const text = renderReceipt({
      outcome: 'worktree-red',
      exitCode: 1,
      track: 't1',
      reason: '轨道工作树 gate 退出码 1',
      mainRoot: '/repo',
      mainBranch: 'main',
      trackPath: '/repo/.worktrees/task-t1',
      branch: 'track/t1',
      branchSha: 'b'.repeat(40),
      preSha: 'a'.repeat(40),
      mergeSha: null,
      finalSha: 'a'.repeat(40),
      startedAt: d,
      endedAt: d,
      steps: ['第一步', '第二步\n多行细节'],
      installs: [],
      worktreeGate: { label: '工作树 gate', cmd: ['bun', 'run', 'gate'], cwd: '/repo/.worktrees/task-t1', exitCode: 1, durationMs: 1234, output: '```\n坏了\n' },
      mainGate: null,
      conflicts: [],
      warnings: [],
      receiptPath: null,
    });
    expect(text).toContain('| 轨道 | t1（工作树 `.worktrees/task-t1`） |');
    expect(text).toContain('````text\n```\n坏了\n````');
    expect(text).toContain('2. 第二步');
    expect(text).toContain('   多行细节');
    expect(text.endsWith('\n')).toBe(true);
  });
});
