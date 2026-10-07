/** tools/sim 共用的路径常量（全部基于仓库根，与当前工作目录无关）。 */
import { resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dir, '..', '..');
export const SIM_DIR = resolve(REPO_ROOT, 'packages/sim');
export const SIM_ENTRY = resolve(SIM_DIR, 'src/index.ts');
export const SIM_DIST = resolve(SIM_DIR, 'dist');
export const SIM_JS = resolve(SIM_DIST, 'sim.js');
export const SIM_DTS = resolve(SIM_DIST, 'sim.d.ts');
export const SIM_VERSION_FILE = resolve(SIM_DIST, 'sim.version');
export const SIM_DTS_TSCONFIG = resolve(SIM_DIR, 'tsconfig.dts.json');
export const TSC_BIN = resolve(REPO_ROOT, 'node_modules/.bin/tsc');
