/**
 * 测试用的临时 git 仓库沙箱（merge 与 hooks 的测试共用；文件名不含 .test，bun test 不会把它当测试跑）。
 *
 * - 所有目录建在 os.tmpdir() 的 mkdtemp 下，cleanup() 一并删除；
 * - isolate() 期间 process.env 去掉全部 GIT_* 变量（防止测试在 git 钩子里运行时误操作外层仓库），
 *   并用空的全局配置（GIT_CONFIG_GLOBAL 指向空文件、GIT_CONFIG_NOSYSTEM=1）屏蔽本机的签名、钩子目录等设置；
 *   被测代码继承 process.env，所以也在隔离环境里跑。bun test 在同一进程里顺序执行各测试文件，afterAll 里必须 restore。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const HAS_GIT = Bun.which('git') !== null;

export class Sandbox {
  private readonly dirs: string[] = [];
  private saved: Record<string, string | undefined> | null = null;
  readonly base: string;

  constructor(prefix: string) {
    this.base = mkdtempSync(join(tmpdir(), `${prefix}-`));
    this.dirs.push(this.base);
  }

  /** 在沙箱里新建一个空目录。 */
  dir(name: string): string {
    const d = join(this.base, name);
    mkdirSync(d, { recursive: true });
    return d;
  }

  /** 隔离 git 环境（见文件头）。 */
  isolate(): void {
    if (this.saved) return;
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('GIT_')) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    }
    const globalCfg = join(this.base, 'empty-gitconfig');
    writeFileSync(globalCfg, '');
    for (const [k, v] of Object.entries({ GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1' })) {
      if (!(k in saved)) saved[k] = process.env[k];
      process.env[k] = v;
    }
    this.saved = saved;
  }

  restore(): void {
    if (!this.saved) return;
    for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];
    for (const [k, v] of Object.entries(this.saved)) if (v !== undefined) process.env[k] = v;
    this.saved = null;
  }

  cleanup(): void {
    this.restore();
    for (const d of this.dirs) rmSync(d, { recursive: true, force: true });
  }
}

/** 跑 git（继承 process.env，应在 isolate() 之后调用）；失败抛错，返回去掉首尾空白的 stdout。 */
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败（${r.status}）：${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}

/** 跑 git，不论成败都返回结果。 */
export function gitRaw(cwd: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 写文件（自动建父目录）。 */
export function put(root: string, rel: string, content: string): string {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

/** git init -b main，设本地身份、关签名；返回目录。 */
export function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', '测试者');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

/** git add -A && git commit（不跑钩子）；返回新提交的 sha。 */
export function commitAll(dir: string, message: string): string {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}
