/**
 * bun install 的 postinstall：把 git 钩子目录指向仓库内的 .githooks。
 * 不在 git 仓库里（例如解压的源码包）时静默跳过，绝不让安装失败。
 */
import { spawnSync } from 'node:child_process';

const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
  console.log('[hooks] 不在 git 工作树中，跳过 core.hooksPath 设置');
} else {
  const set = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { encoding: 'utf8' });
  if (set.status === 0) {
    console.log('[hooks] 已设置 core.hooksPath = .githooks');
  } else {
    console.warn(`[hooks] 设置 core.hooksPath 失败（不影响安装）：${set.stderr.trim()}`);
  }
}
