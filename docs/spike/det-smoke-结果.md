# 确定性冒烟实测（2026-10-07，Mac arm64）

脚本：`det-smoke.js`。2,000 次随机击球，二次阻力 RK4（1/60 s）、xorshift32、对 Float64 位模式做 FNV-1a，每 30 步混入完整状态。

| 引擎 | dsqrt 路径 | Math.sqrt 路径 | sin/exp/pow/atan2 |
|---|---|---|---|
| Node 24 arm64（V8） | 3e34ca | e0082e4a | 17fb5a11 |
| Node 24 x86_64（Rosetta，V8） | 3e34ca | e0082e4a | dd072c50 |
| Bun 1.4（JSC JIT） | 3e34ca | e0082e4a | 4c8cf200 |
| `BUN_JSC_useJIT=0 bun`（JSC 解释器） | 3e34ca | e0082e4a | — |
| jsc（JSC JIT） | 3e34ca | e0082e4a | 4c8cf200 |
| jsc --useJIT=false（JSC 解释器） | 3e34ca | e0082e4a | 4c8cf200 |

结论：四则运算 + dsqrt（或 Math.sqrt）跨引擎逐位一致；超越函数不一致；dsqrt 与 Math.sqrt 约 25% 输入差 1 ulp，只能二选一（本项目用 dsqrt）。
`BUN_JSC_useJIT=0` 比 JIT 慢约 4.5 倍，可作 Linux 上的 JSC 解释器替身。
