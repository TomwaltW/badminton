/**
 * tools/hooks/install.ts（bun install 的 postinstall）的测试：
 * 在临时 git 仓库里真的跑 bun install，确认 postinstall 设置了 core.hooksPath=.githooks；
 * 非 git 目录与"别的仓库里的子目录"静默跳过且不让安装失败。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { HOOKS_PATH, installHooks } from '../install';
import { HAS_GIT, Sandbox, git, gitRaw, initRepo, put } from '../../merge/test/sandbox';

const REPO = resolve(import.meta.dir, '..', '..', '..');
const ROOT_PKG = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
const POSTINSTALL = ROOT_PKG.scripts.postinstall ?? '';
const INSTALL_SRC = readFileSync(join(REPO, 'tools', 'hooks', 'install.ts'), 'utf8');

let sb: Sandbox;
beforeAll(() => {
  sb = new Sandbox('hooks-install-test');
  sb.isolate();
});
afterAll(() => sb.cleanup());

/** 在 dir 里放一个只有 postinstall（取自真实根 package.json）的 package.json 与 install.ts 的副本。 */
function scaffold(dir: string): void {
  put(dir, 'package.json', `${JSON.stringify({ name: 'install-sandbox', private: true, scripts: { postinstall: POSTINSTALL } }, null, 2)}\n`);
  put(dir, 'tools/hooks/install.ts', INSTALL_SRC);
}

/** 在 dir 里跑 bun install（没有依赖，不联网）。 */
function bunInstall(dir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['install'], {
    cwd: dir,
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`, ...extraEnv },
    encoding: 'utf8',
  });
}

const hooksPath = (dir: string) => gitRaw(dir, 'config', '--get', 'core.hooksPath').stdout.trim();

test('根 package.json 的 postinstall 调用 tools/hooks/install.ts', () => {
  expect(POSTINSTALL).toBe('bun tools/hooks/install.ts');
});

describe.skipIf(!HAS_GIT)('bun install 的 postinstall（临时目录）', () => {
  test('git 仓库里：bun install 之后 core.hooksPath = .githooks；再装一次不重复写', () => {
    const repo = initRepo(sb.dir('repo'));
    scaffold(repo);
    expect(hooksPath(repo)).toBe('');
    const r = bunInstall(repo);
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('[hooks] 已设置 core.hooksPath = .githooks');
    expect(hooksPath(repo)).toBe(HOOKS_PATH);
    // 写在仓库本地配置里
    expect(git(repo, 'config', '--local', '--get', 'core.hooksPath')).toBe('.githooks');

    const again = bunInstall(repo);
    expect(again.status).toBe(0);
    expect(`${again.stdout}${again.stderr}`).toContain('core.hooksPath 已是 .githooks');
  });

  test('非 git 目录：静默跳过，安装照常成功', () => {
    const dir = sb.dir('plain');
    scaffold(dir);
    // 不让 git 向上找到沙箱之外的仓库
    const r = bunInstall(dir, { GIT_CEILING_DIRECTORIES: dirname(dir) });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('[hooks] 不在 git 工作树中，跳过');
  });

  test('只是别的 git 仓库里的子目录：跳过，不改外层仓库的配置', () => {
    const outer = initRepo(sb.dir('outer'));
    const inner = join(outer, 'vendor', 'badminton');
    scaffold(inner);
    const r = bunInstall(inner);
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('不是 git 工作树的根');
    expect(hooksPath(outer)).toBe('');
  });

  test('installHooks：链接工作树里同样生效（配置在共享的 .git/config 里）', () => {
    const repo = initRepo(sb.dir('wt-repo'));
    put(repo, 'a.txt', 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '--no-verify', '-m', '初始');
    git(repo, 'worktree', 'add', '-q', join(repo, '.worktrees', 'task-t1'), '-b', 'track/t1');
    const wt = join(repo, '.worktrees', 'task-t1');
    expect(installHooks(wt).status).toBe('set');
    expect(hooksPath(repo)).toBe(HOOKS_PATH);
    expect(installHooks(repo).status).toBe('already');
  });
});
