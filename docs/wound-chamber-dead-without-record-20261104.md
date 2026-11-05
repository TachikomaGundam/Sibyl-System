# 伤单：无头评审庭 dead-without-record（run sibyl-20261102T133505Z-4393）

- 日期：2026-11-04 · 登记：座席 ses_e73461d65ffeTD6YoOBTVGC2gA（发起方席位）· 状态：修复随本单落地，待机主发布
- 后果定级：**治理器具受伤**（评分/审计面输出与其宣称语义矛盾的反面：声称开庭、实际无任何输出、且**连死亡都没有记录**——违 W2 absent-without-record 类）

## 症状与机器证据（当场探测，非叙事）

| 探针 | 命令 | 输出 |
|---|---|---|
| 开庭时刻 | run 目录名内嵌（工具铸造） | `20261102T133505Z` = 本地 2026-11-02 21:35 +08 |
| 38h 后目录内容 | `ls /tmp/sibyl-run-sibyl-20261102T133505Z-4393/` | 仅 `launch-context.json`、`run-config.json` **两个工具侧文件**；无 `target/`、无 `pids/`、无角色目录、无 `run-record.json`、无 `chamber-ledger.jsonl` |
| 中央账本 | `grep -c sibyl-20261102T133505Z-4393 ~/.sibyl/runs.json` | `0`（consult 类 store 无登记） |
| 判死时刻 | `date` | 2026-11-04 14:33 +08（距开庭 40h58m ≫ roleTimeoutMs=600s） |

关键推断：runner 正常推进的第一步副作用是 `target/` 拷贝（`src/cli.ts` resolveRun，先于任何 spawn）。`target/` 缺席 ⇒ **runner 死在 resolveRun 之前或模块加载期**；角色目录/账本全缺 ⇒ 从未进入 phase。

## 盲区归因（为什么死了没人知道）

1. `src/tools/review.ts` L115：runner 子进程 `stdio:"ignore"`、`detached`，`child.on("error")` 只 `console.error` 到**工具会话即抛即丢**——runner 的任何早死（配置解析炸、模块加载炸、未处理 rejection）不留一个字节。
2. `src/cli.ts` 底部入口 `process.exitCode = await main(...)` **无 fatal 兜底**：任何异常栈进丢失的 stderr。
3. `status` 面只读中央 ledger：目录存在 + ledger 无行 = 显示「no chamber runs recorded」，与「从未开过庭」不可区分——消费方（座席）只能靠手看目录猜。
   （同类先例：2026-10-23 死路径静默死亡，`cliCommand` 注释在案——本伤是同一病类的**第二犯**：上次修了路径解析，这次修「死了必须留痕」。按 L-INVARIANT-FIRST，第二犯必须立结构修复，本单即为结构修复。）

## 修复（本单附带，最小语义修正，不放松任何 fail-closed）

1. `review.ts`：runner spawn 的 stdout/stderr 改接 `<runDir>/startup.log`（打开失败退回 ignore，不阻断开庭）。
2. `cli.ts`：入口 fatal 兜底——任何异常/未处理 rejection 写 `<runDir>/startup-error.json`（runDir 由 `--run-root`+`--run-id` 推导，缺省 `/tmp`），随后 `exitCode=1`。
3. `cli.ts` status：`--run-id` 指名但 ledger 无行且 run 目录存在时，输出具名 `dead-without-record` 行（列明目录内实况）；目录不存在则维持原文案。exit 仍 0（信息面，不新增否决语义）。

## 复现与验收

- 复现（修复后的可判面）：向一个只有 `run-config.json`（缺 launch-context）的目录用 `--run-id` 起 runner 之外的人为 fatal（如指向损坏 config），`status --run-id` 必须打印 `dead-without-record`，且 `startup-error.json` 落盘。
- 修复后全量测试：`npm test`（见 CHANGELOG 条目与提交）。
- 双链留痕：本单 + Sibyl 提交 + 本行注记。

## 处置记录

- 2026-11-04 本单登记；同次审查中 `sibyl_consult` Lane 正常（run `sibyl-20261104T063130Z-ffd5` 完整留痕），故裁决链未断，仅 chamber lane 受伤。
- 发布（npm 版本、tag、push）= 人类门，不在本单范围。
