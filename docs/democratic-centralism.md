# 民主集中制评审装置（Democratic-Centralism Review Chamber）— v1.1

provenance: Abathur seat, Sibyl-System (西比拉系统正式名; package sibyl-system; dir harness/magi 为旧名) v1.1, 2026-09-24.
Orders: INTENT-LEDGER.md ORD-1 (handoff 进化西比拉系统) + ORD-2 (general review,
internal high-intensity clash, broad evidence, external ONE conclusion ONE voice).
Design law: docs/EVOLUTION-DESIGN.md. This file is the mechanism contract.

## 1. 定位：任意评审，不只一个回路

`sibyl_review`（插件工具）与 `sibyl-chamber run`（CLI）是同一装置的两个门：
文档评审、计划评审、代码评审、行为考卷（exam profile）都走同一条
EVIDENCE → CLASH → JUDGE → SYNTHESIS 流水线。评审对象与被评审者是谁，
装置不关心；它只保证过程纪律与单一声音。

## 2. 民主（内部：高对抗、密集交锋、广泛来源）

| 阶段 | 谁 | 可见性 | 产物（磁盘=状态，L5） |
|---|---|---|---|
| EVIDENCE | 取证席 | 独立会话 | `evidence/evidence.jsonl`（每行一个 JSON 证据行；先枚举后取样，广度优先） |
| CLASH 第 r 轮草稿 | PRO / CON 并行 | **互相盲**：任何一方看不到对方原始输出 | `pro/round-r.md`（编号主张 C1..）/ `con/round-r.md`（编号指控 N1..，每条必须引路径/引文） |
| 交叉批判 | PRO / CON 并行 | 只给对方**已写盘产物**的路径 | `pro/round-rebuttal-r.md` / `con/…`（按对方编号逐条 CONCEDE/REBUT） |
| 裁决 | JUDGE（E2 抽签定席，池+seed 在首发射击前以 drawCommit 固化） | 读全部产物 + 证据账本 + 原始目标；廉价处逐行复核引用 | `judge/round-r.json`（严格语法：convergence/conclusion/confidence/reasons/must_fix/charges） |

轮次上限 `chamber.maxRounds`（默认 3，硬上限 8）。judge 判 NEEDS_ROUND 时，其
`charges` 注入下一轮 pro/con 提示词——交锋被指控驱动，不空转。每轮 judge 输出
被机械追加进 `DISAGREEMENT-LOG.md`（异议留痕是档案，不是二次发言）。

盲制与"会话=阶段而非人格"是防勾结设计：任何成员从不看对方 raw 输出，磁盘产物
是唯一媒介，且只在交叉批判步显式发布。

## 3. 集中（对外：一个结论、一个声音）

`src/chamber/synthesis.ts` 把（终态, judge 裁决, 缺口表）映射为**恰好一条**外部
信息（`renderVoice`）：

- `conclusion ∈ {APPROVE, REJECT, NEEDS_HUMAN}`；无任何默认 APPROVE 路径——
  席位被拒、进程死亡、超时、裁决语法不合、轮次耗尽 ⇒ NEEDS_HUMAN 并点名缺口。
- 内部交锋**不删除、不播报**：以 路径+哈希 密封在 run 目录（`dissent_sealed_in`），
  外部只引用、不倾倒。`singleVoiceCheck` 是机械哨兵：渲染文本里出现第二个结论
  token 或任何内部章节标题 = 违宪，测试直接红。
- 声音自带：confidence、≤6 条 rationale、must_fix、open_charges、serial、
  一条 spotcheck 命令（见 isolation-laws.md 的抽查合同）。
- 诚实上限：单 uid 机器 ⇒ `honesty: PERFORMANCE-ONLY-IN-LOOP` 印在声音上，
  直到 C-09/C-14 容器化裁决落地（HD-2/HD-3，人类权限决定）。

## 4. 失败即档案（L6 显式终态）

`CONVERGED` / `NEEDS_ROUND`（轮尽）/ `MEMBER_LOST`（席死，产物部分保留可复核）/
`TIMEOUT`。每个终态触发 face 记录再生 + CHECKSUMS + ledger EOF 追加——静默
no-op 在本装置里是**不可表示的**。infra 失败不重试刷屏：一轮宣告性重试后转
NEEDS_HUMAN（人类决定是否续跑）。

## 5. exam profile（行为考卷 = 同一装置的第二个消费者）

`--profile exam --scenario file.json`：场景是数据（`scenarios/*.json`，
schema 见 `src/exam/scenario.ts`），信号是机械的（`src/exam/signals.ts` 从
`--format json` 事件流+磁盘复核提取：order=纠偏前必须同回合重探针；absent=
禁区模式不得出现；disk=世界状态必须持有验证值；text=终答行为）。
canary 挂 = 一票否决（REJECT + CANARY-VETO），不靠考生自供，靠观测行为
（A3 已证：脚本化造假 transcript 被机械抓住，诚实对照通过同一组信号）。

## 6. 使用

```
node src/cli.ts run --target doc.md --goal "Is it sound?" --model local-qwen/qwen3.8-flash-next
node src/cli.ts status --run-id <id>
node src/cli.ts spotcheck <runId>      # 打印人类可粘贴的字节级验证命令
node src/cli.ts kill <runDir> <role>   # 只认 pidfile 数字（L4）
```
插件内：`sibyl_review(target, goal, seed?, maxRounds?)` 返回发射回执（回执不是
结论），终态声音看 run-record / status。
