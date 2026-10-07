# @badminton/contracts 变更记录

规则（计划 2.3、4.2）：契约由 INT 直接改；每次改动 bump 版本并在这里记一行，当天通知各轨合一次主干。
快照布局冻结后到 12-21 前只许追加（`fixtures/snapshot-layout.v0.json` 为基线，测试守护）。

- v0 草案（2026-10-08）：模拟 API 与时间单位（`api.ts`：SIM_HZ=30、U_PER_TICK=1000、U_PER_MS=30，InputEvent、INPUT_KIND、SIM_EVENT 打包格式、Sim / CreateSim 类型、ContentBundle 与 ShotTables 占位接口）；MatchCfg / PlayerCfg 与 22×i32 编码（`match-cfg.ts`）；InputEvent 16 字节编码（`input-event.ts`）；快照布局字段表与偏移生成器（`snapshot.schema.ts`、`gen/snapshot-offsets.ts`，SNAPSHOT_SCHEMA_VER=0）；BMRP 回放 fmt=0（`replay.ts`）；夹具见 `fixtures/`；整数字段一律拒绝 −0（`NEG_ZERO_HINT`：量化结果请 |0 归一）。待审定项写在注释里：`POS_RING_LEN` 的回溯余量、快照 SIM_VER 槽由谁写入与 `hash()` 是否计入身份头。待 10-11 审定冻结为 v1。
