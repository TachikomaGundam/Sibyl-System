# 隔离法 L1–L7 落地合同（Isolation Laws, v1.1）

provenance: Abathur seat, harness/magi v1.1, 2026-09-24. 法源:
PCB-Agent/.omo/self-audit/SWARM-EVOLUTION-HANDOFF.md（L1–L7 + E1–E6 + A1–A5）；
每条给出"机器可复核的实现位置 + 测试名"，违反任一条 = 测试红，不是文档建议。

| 法 | 条文 | 实现 | 复核 |
|---|---|---|---|
| L1 | 角色会话一律在 `<runDir>/<role>/home` 下的专属 HOME/XDG/OPENCODE_DB；人类主 opencode.db 零新增会话 | `src/lane/isolated.ts prepareRoleHome`（env 钉死 + PATH 钉 `/usr/bin:/bin` + 禁自动更新） | 单测 `prepareRoleHome: dirs + copied config + pinned env`；stub 子进程**自证** HOME 在 run 目录下（`launchRole end-to-end with stub env`）；活体：`e2e/acceptance.mjs` A1 前后 `sqlite3 -readonly` 数主库 `title LIKE 'sibyl-%'` delta=0 |
| L2 | 用户空间硬只读：不碰 `~/.bashrc`/PATH/`~/.local/bin`，不绕 `+i` 锁 | 配置以 **read-copy** 进角色家目录（`configSource` 只读源文件）；本仓库代码无任何用户 rc 写路径 | 代码审 + 验收不新增非 /tmp 落盘（runRoot=/tmp，state 仅 `~/.sibyl/` 追加账本——插件既有契约） |
| L3 | 不走框架外通道：编排只在 opencode 框架内（`opencode run` 是框架无头入口） | CLI 用 `opencode run [--session]`，插件用 SDK client；无 alias/包装器/启动脚本改动 | `composeRunArgs` 是唯一 argv 事实源（单测锁形状） |
| L4 | 进程纪律：只按 pidfile 里的数字 pgid 击杀；禁模式杀 | `launchRole` detached 组 + `pids/<role>.pid`（spawn 后立刻写）；`killRole` 只读 pidfile，缺失即拒绝并报"refusing to search" | 单测 `killRole: pidfile-only kill; missing pidfile is a refusal`；活体 A2 `--kill-role judge` → MEMBER_LOST |
| L5 | 写前不答：成员状态=磁盘产物，死成员的产物仍可用 | 提示词内置 OUTPUT CONTRACT（增量写盘、落盘即收据）；`#phase` 收据检查读文件而非信 reply | 单测 `judge killed mid-phase → partials kept`；活体 A2 断言 pro/con 产物 ≥2 且哈希可复核 |
| L6 | 显式终态：CONVERGED / NEEDS_ROUND / MEMBER_LOST / TIMEOUT，静默 no-op 不可表示 | `state/chamber.ts TERMINAL_STATES`；`#close` 必带终态 + 缺口表；超时与击杀在 record 里可区分（timedOut 旗标） | 三条单测分别钉 TIMEOUT-partial、MEMBER_LOST、轮尽 NEEDS_ROUND |
| L7 | 面后追加：ledger 只在 EOF 追、一行一个 JSON（合并行必炸）；face 记录是阶段**最后**一次写；一切声明先经磁盘复核 | `appendLedgerRow`（O_APPEND + 单行拒绝）、`parseLedgerLine`（合并行=解析失败）、`finalizeRecord`（artifacts 全量 sha 复核→checksums→ledger 行镜像→face 最后写）、`assertOnDisk` | A5：`parseLedgerLine: A5 merged-row fixture MUST fail` + `finalizeRecord: clean run writes checksums then the face LAST`；A4：`sha256sum -c CHECKSUMS.txt`（活体正反两跑：原样 OK / 篡改必炸） |

## 诚实上限（SR3）

单 uid 机器上，以上机制把作弊做成**响亮**（serial 漂移、哈希漂移、canary 哑火
都会留下机械证据），不是**不可能**。容器化（C-09）与权限裁决（C-14：本机 uid
在 sudo/docker/lxd 组，属人类决定）落地前，每个行为考卷声音自带
`PERFORMANCE-ONLY-IN-LOOP` 字样。E2 抽签的 drawCommit（池∥seed 哈希）写进
START 记录，事后再改池/seed 与提交矛盾——抽查一条命令即可复核。

## 已知残余（不粉饰）

1. 角色以完整 agent 运行（非 --pure 沙箱内再锁工具面）：/tmp 外的写能力在
   uid 权限内仍存在，靠 L5/L7 事后审计而非事前不可为。
2. `resolveSeat` 沿用 v1.0 链：具名槽位缺失静默落 `default`——deny 只惩罚
   **解析后的模型**违反 policy；槽位拼写错误不炸（历史语义，改动需版本决定）。
3. ledger 在 `~/.sibyl/`（跨运行共享）：每行镜像 `ledger-line.txt` 进 run 目录
   使单 run 抽查可独立成立；全账本的防篡改依赖 EOF-append + 物理计数序列号
   （被删行会使后续 serial 对不上）。
