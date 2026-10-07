/**
 * pre-commit 钩子的测试。临时 git 仓库里复制 eslint.config.js、把 node_modules 符号链接到真实仓库，
 * 证明钩子查的是暂存版本：暂存违规版本 → 拦下；暂存干净版本但工作树改脏 → 通过；反过来 → 拦下。
 * 另有端到端用例：复制 .githooks/pre-commit 与它的 TS 依赖，真的跑 git commit。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isLintTarget, runPreCommit } from '../pre-commit';
import { HAS_GIT, Sandbox, commitAll, git, gitRaw, initRepo, put } from '../../merge/test/sandbox';

const REPO = resolve(import.meta.dir, '..', '..', '..');
const HOOK_SH = join(REPO, '.githooks', 'pre-commit');
const HAS_DEPS = existsSync(join(REPO, 'node_modules', 'eslint')) && existsSync(join(REPO, 'tools', 'sim', 'scan.ts'));

const BAD_SIM = 'export const y = Math.sin(1);\n';
const GOOD_SIM = 'export const y = Math.abs(-1);\n';

let sb: Sandbox;
beforeAll(() => {
  sb = new Sandbox('pre-commit-test');
  sb.isolate();
});
afterAll(() => sb.cleanup());

/** 复制 rel 及其相对路径导入（递归，补 .ts 扩展名）到 dstRoot 的同一位置。 */
function copyWithDeps(rel: string, dstRoot: string, seen = new Set<string>()): void {
  if (seen.has(rel)) return;
  seen.add(rel);
  const src = join(REPO, rel);
  const dst = join(dstRoot, rel);
  put(dstRoot, rel, readFileSync(src, 'utf8'));
  chmodSync(dst, statSync(src).mode & 0o777);
  const text = readFileSync(src, 'utf8');
  for (const m of text.matchAll(/(?:from\s+|import\()\s*'(\.\.?\/[^']+)'/g)) {
    let dep = join(dirname(rel), m[1]!);
    if (!/\.[cm]?[jt]s$/.test(dep)) dep += '.ts';
    if (existsSync(join(REPO, dep))) copyWithDeps(dep, dstRoot, seen);
  }
}

let seq = 0;
/** 带 eslint.config.js 与 node_modules 符号链接的临时仓库（已有一个初始提交）。 */
function setup(): string {
  const root = initRepo(sb.dir(`repo${++seq}`));
  copyFileSync(join(REPO, 'eslint.config.js'), join(root, 'eslint.config.js'));
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'));
  put(root, 'package.json', `${JSON.stringify({ name: 'hook-sandbox', private: true, type: 'module' }, null, 2)}\n`);
  put(root, '.gitignore', 'node_modules\n');
  put(root, 'README.md', '临时仓库\n');
  commitAll(root, '初始');
  return root;
}

interface Captured {
  code: number;
  out: string;
  err: string;
}

async function hook(root: string): Promise<Captured> {
  let out = '';
  let err = '';
  const code = await runPreCommit(root, { out: (s) => void (out += s), err: (s) => void (err += s) });
  return { code, out, err };
}

test('isLintTarget：只认 .ts/.js/.mjs/.cjs', () => {
  expect(['a.ts', 'b/c.js', 'd.mjs', 'e.cjs'].every(isLintTarget)).toBe(true);
  expect(['a.md', 'b.json', 'c.tsx', 'pre-commit', 'd.ts.bak'].some(isLintTarget)).toBe(false);
});

test('.githooks/pre-commit 是可执行的 sh 脚本，exec 工作树里的 tools/hooks/pre-commit.ts', () => {
  expect(statSync(HOOK_SH).mode & 0o111).not.toBe(0);
  const text = readFileSync(HOOK_SH, 'utf8');
  expect(text.startsWith('#!/bin/sh\n')).toBe(true);
  expect(text).toContain('$HOME/.bun/bin/bun');
  expect(text).toContain('tools/hooks/pre-commit.ts');
});

describe.skipIf(!HAS_GIT || !HAS_DEPS)('runPreCommit（临时 git 仓库）', () => {
  test('没有相关暂存文件 → 快速通过', async () => {
    const root = setup();
    put(root, 'README.md', '改了说明\n');
    git(root, 'add', 'README.md');
    const r = await hook(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('跳过 ESLint 与 sim:scan');
  });

  test('暂存违规的 packages/sim/src/x.ts → 返回非 0，ESLint 与 sim:scan 都报', async () => {
    const root = setup();
    put(root, 'packages/sim/src/x.ts', BAD_SIM);
    git(root, 'add', 'packages/sim/src/x.ts');
    const r = await hook(root);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('no-restricted-syntax');
    expect(r.err).toContain('packages/sim/src/x.ts:1:');
    expect(r.err).toContain('[math-member]');
    expect(r.out).toContain('ESLint：1 个暂存文件，1 个错误');
    expect(r.out).toContain('sim:scan（暂存区）：1 个文件，1 处违规');
    expect(r.err).toContain('提交被拦下');
  });

  test('暂存干净版本、工作树改脏 → 通过（查的是暂存版）', async () => {
    const root = setup();
    put(root, 'packages/sim/src/x.ts', GOOD_SIM);
    git(root, 'add', 'packages/sim/src/x.ts');
    put(root, 'packages/sim/src/x.ts', BAD_SIM); // 工作树改脏，不 git add
    const r = await hook(root);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('ESLint：1 个暂存文件，0 个错误');
    expect(r.out).toContain('sim:scan（暂存区）：1 个文件，0 处违规');
  });

  test('暂存违规版本、工作树改干净 → 仍拦下（反向证明）', async () => {
    const root = setup();
    put(root, 'packages/sim/src/x.ts', BAD_SIM);
    git(root, 'add', 'packages/sim/src/x.ts');
    put(root, 'packages/sim/src/x.ts', GOOD_SIM);
    const r = await hook(root);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('[math-member]');
  });

  test('模拟核心以外的文件也跑 ESLint：工具脚本的 no-undef、语法错误都拦', async () => {
    const root = setup();
    put(root, 'tools/x/a.js', 'undefinedThing = 1;\n');
    put(root, 'tools/x/b.ts', 'export const = ;\n');
    git(root, 'add', '-A');
    const r = await hook(root);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('no-undef');
    expect(r.err).toContain('Parsing error');
    expect(r.out).toContain('ESLint：2 个暂存文件，2 个错误');
    // 不在 sim:scan 范围内
    expect(r.out).toContain('sim:scan（暂存区）：0 个文件，0 处违规');
  });

  test('ESLint 忽略的路径跳过（docs/spike/**）', async () => {
    const root = setup();
    put(root, 'docs/spike/old.js', 'undefinedThing = Math.sin(1);\n');
    git(root, 'add', '-A');
    const r = await hook(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('ESLint：0 个暂存文件（1 个被忽略）');
  });

  test('删除文件不算（--diff-filter=ACMR）', async () => {
    const root = setup();
    put(root, 'packages/sim/src/x.ts', BAD_SIM);
    commitAll(root, '历史上的坏文件');
    git(root, 'rm', '-q', 'packages/sim/src/x.ts');
    const r = await hook(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('跳过');
  });
});

describe.skipIf(!HAS_GIT || !HAS_DEPS)('端到端：git commit 触发 .githooks/pre-commit', () => {
  test('违规提交被拦、修好后能提交；git commit -a 用临时索引时也查得到', () => {
    const root = setup();
    copyWithDeps('.githooks/pre-commit', root);
    copyWithDeps('tools/hooks/pre-commit.ts', root);
    expect(existsSync(join(root, 'tools', 'sim', 'scan.ts'))).toBe(true);
    git(root, 'config', 'core.hooksPath', '.githooks');
    git(root, 'add', '-A');
    // 钩子脚本以 100755 跟踪
    expect(git(root, 'ls-files', '-s', '.githooks/pre-commit').split(/\s+/)[0]).toBe('100755');
    commitAll(root, '加入钩子'); // --no-verify：钩子自己的 TS 依赖不在本测试的检查范围

    const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
    const commit = (...args: string[]) => spawnSync('git', ['commit', '-q', ...args], { cwd: root, env, encoding: 'utf8' });

    const before = git(root, 'rev-parse', 'HEAD');
    put(root, 'packages/sim/src/x.ts', BAD_SIM);
    git(root, 'add', 'packages/sim/src/x.ts');
    const bad = commit('-m', '坏提交');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('[math-member]');
    expect(bad.stderr).toContain('提交被拦下');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before);

    put(root, 'packages/sim/src/x.ts', GOOD_SIM);
    git(root, 'add', 'packages/sim/src/x.ts');
    const good = commit('-m', '好提交');
    expect(good.status).toBe(0);
    expect(git(root, 'rev-parse', 'HEAD')).not.toBe(before);

    // git commit -a：改动没 git add，git 在临时索引里暂存后再跑钩子（GIT_INDEX_FILE）
    put(root, 'packages/sim/src/x.ts', BAD_SIM);
    const head = git(root, 'rev-parse', 'HEAD');
    const all = commit('-a', '-m', 'commit -a 坏提交');
    expect(all.status).not.toBe(0);
    expect(all.stderr).toContain('[math-member]');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(gitRaw(root, 'diff', '--cached', '--quiet').status).toBe(0); // 真实索引没被动过
  });

  test('找不到 bun 时打印中文提示并失败；$HOME/.bun/bin/bun 作为后备', () => {
    if (existsSync('/usr/bin/bun') || existsSync('/bin/bun')) return; // 系统目录里有 bun 时无法构造"找不到"的环境
    const root = setup();
    copyWithDeps('.githooks/pre-commit', root);
    const home = sb.dir(`home${seq}`);
    const run = () =>
      spawnSync('/bin/sh', [join(root, '.githooks', 'pre-commit')], {
        cwd: root,
        env: { PATH: '/usr/bin:/bin', HOME: home },
        encoding: 'utf8',
      });
    const missing = run();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('找不到 bun');

    // 假 bun：打印收到的参数并以 42 退出
    put(home, '.bun/bin/bun', '#!/bin/sh\necho "假 bun $*"\nexit 42\n');
    chmodSync(join(home, '.bun/bin/bun'), 0o755);
    const fallback = run();
    expect(fallback.status).toBe(42);
    expect(fallback.stdout.trim()).toBe(`假 bun ${join(root, 'tools', 'hooks', 'pre-commit.ts')}`);
  });
});
