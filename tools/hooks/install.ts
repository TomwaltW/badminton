/**
 * bun install 的 postinstall：把 git 钩子目录指向仓库内的 .githooks（计划 4.2）。
 *
 * - 仓库根取本文件所在位置（tools/hooks/../..），与当前目录无关；
 * - 不在 git 工作树中（例如解压的源码包）时跳过，只打印一行说明；
 * - 本仓库只是别的 git 仓库里的一个子目录时也跳过（不能去改外层仓库的配置）；
 * - 已经是 .githooks 时不重复写；
 * - 任何情况下都不让安装失败（退出码恒为 0）。
 * 所有工作树共享 .git/config，在主干或任一 .worktrees/task-xx 里装一次即可；hooksPath 是相对路径，
 * git 在哪个工作树里提交，就运行那个工作树自己的 .githooks/pre-commit。
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export const HOOKS_PATH = '.githooks';

export type InstallStatus = 'set' | 'already' | 'skipped' | 'failed';

function canon(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** 在 root 上设置 core.hooksPath；返回状态与说明（不抛错）。 */
export function installHooks(root: string): { status: InstallStatus; message: string } {
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.error || top.status !== 0) {
    return { status: 'skipped', message: '不在 git 工作树中，跳过 core.hooksPath 设置' };
  }
  const toplevel = top.stdout.trim();
  if (canon(toplevel) !== canon(root)) {
    return {
      status: 'skipped',
      message: `${root} 不是 git 工作树的根（所在仓库根是 ${toplevel}），跳过 core.hooksPath 设置`,
    };
  }
  const cur = git(['config', '--get', 'core.hooksPath']);
  if (cur.status === 0 && cur.stdout.trim() === HOOKS_PATH) {
    return { status: 'already', message: `core.hooksPath 已是 ${HOOKS_PATH}` };
  }
  const set = git(['config', 'core.hooksPath', HOOKS_PATH]);
  if (set.status === 0) return { status: 'set', message: `已设置 core.hooksPath = ${HOOKS_PATH}` };
  return { status: 'failed', message: `设置 core.hooksPath 失败（不影响安装）：${(set.stderr ?? '').trim()}` };
}

if (import.meta.main) {
  try {
    const r = installHooks(resolve(import.meta.dir, '..', '..'));
    (r.status === 'failed' ? console.warn : console.log)(`[hooks] ${r.message}`);
  } catch (e) {
    console.warn(`[hooks] 设置钩子时出错（不影响安装）：${(e as Error).message}`);
  }
}
