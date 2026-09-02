> 注：文中 "MAGI" 为项目曾用名，产品现已更名为 Sibyl-System（记录保留原名）。

# MAGI 蜂群层检讨报告（G2）

日期：2026-09-02 ｜ 状态：终稿 ｜ 输入：G1 spike（GO）、G2·librarian（Kimi 证据简报）、G2·explore（as-built 审计，file:line 已由主控抽查复核）

---

## 1. 前代原型（内部未发布实现）的派出逻辑 as-built

一句话：**固定模板 + 三处文本替换，不存在任何"派出前分析"。**

时间线（证据源：内部实现源码与其技能定义、内部工作区证据，均不随包发布）：

1. `swarm({artifact, goal, mode})` → 仅做非空校验 + `access()` 存在性检查。**工件文件从未被打开**；类型、领域、长度、风险均不影响任何下游。
2. 落盘的 RunRecord 克隆模块常量 `ROSTER`（固定四人名单）。
3. 指令 = `buildDirective(runId)`（形参只有 runId，**结构上不可能**按工件变化）+ 自然语言 frame（插入 runId/artifactPath/goal）。
4. lead 按技能定义执行静态循环：同一 4 人名单、固定 3 轮、固定合并策略、固定输出文件名。"动态 inline spec"只是给 lead 的自由裁量选项，无推导程序，且 swarm 路径的指令明确强制"the roster above"。
5. 全部 15 个"本应由任务推导"的决策点均为硬编码（名单/角色/模型档位映射/worker 提示词/轮数/评判标准/裁决词表/拓扑/合并策略/路径/队名/预算…，见 as-built 审计 §(c)）。

**三处死代码级缺陷（本次审计新发现）：**
- `mode=refine|debate|generate`：门口校验、落盘、**零读取**——三种模式执行完全相同的字节级指令。
- `judgeCriteria` 随指令发出，但技能定义全文 **0 次引用**——judge 实际只按内部团队配置的静态提示词工作，标准"发了没人收"。
- `RunRecord.round` 恒为 0（无任何写入者）——`swarm_status` 无法报告进度。另有裁决词表分裂：记录 enum `CONVERGED|EXHAUSTED_ROUNDS` vs judge enum `CONVERGED|NEEDS_ROUND`，靠 lead 默默翻译。

唯一真实的运行期适应性 = 失败降级的类别回退（OMO 公开的 unspecified-high 档）。

## 2. 为什么会是这个样子（我的理由）

- **这是计划层的选择，不是实现偷懒。** 该 plan 的 MVP 边界就是"一个固定三角对抗 + 独立裁判的辩论协议"，本体是 **prompt contract（lead+skill 驱动），不是引擎**——前代实现亦自述只组合指令、从不驱动 team_* 运行时。
- **被 OMO team-mode 封顶。** 声明式 roster（1-8 人、zod 校验，OMO dist:5624-5673）、headless NO-GO（spike 复现 3 次：lead step_finish 即取消成员）、≤8 成员、需重启——这些约束使"运行时铸造 worker"在 team-mode 上根本不可实现。
- **整个 OMO 生态都是 static-roster。** hyperplan 同样是固定 4+1 名单 + 固定 3 轮（dist:105325, 113093-113110）。插件没有偏离家法——但因此 **"kimi-style" 名不副实**：交付物没有任何"研究工作流→按需铸造工蜂"的行为，命名承诺与 as-built 不符。检讨结论：**缺陷在范式层。**

## 3. Kimi Agent Swarm 真实机制（证据分级，详见 G2·librarian 简报）

**官方确证**（arXiv:2602.02276 K2.5 技术报告 2026-02-02；kimi.com 博客 K2.5/K2.6/K3/Agent-Swarm；Help Center；MoonshotAI/kimi-code PR#424 已合并 2026-06-08；Kimi Code CLI 文档）：
- 编排是**训练出来的**（PARL）：可训练 orchestrator + 冻结 subagents（"只训教练，运动员冻结"）；orchestrator 学会"从 query 推理所需 subagent 的 **数量、时机、专精**"，异构队伍"有机涌现"；并行不是假设而是**显式学习**的；奖励 r=λ₁·r_parallel+λ₂·r_finish+r_perf，λ 退火归零，专治串行坍缩与伪并行。
- 侦察→扇出**有案例证据**（YouTube 域"先研究并定义各领域"再开 100 蜂；PG 散文按流水线角色分派；100 页文献综述按章节认领）；规模 K2.5=100 蜂/1500 调用、K2.6=300/4000；**上下文分片**："工蜂只把关键结论上报指挥官"。
- 工程机制（CLI 实现可查）：模板化 item 扇出、分批错峰启动、逐任务超时/取消、限流→suspend≠失败、同 agent 重试、自适应重试容量、**按 id 续跑未完成 subagent**、有序聚合；`[secondary_model]` 池 → **主 agent 按次派生选择 worker 模型**。
- 官方自认未完成（roadmap）：subagent 直接互聊、并行宽度动态控制——即 fan-out/fan-in 星型是当前真实形态。

**不能背书**（你的表述 vs 公开证据）：
- "研究过目标工作的理想工作流"→ 无独立"理想工作流研究"模块/工件被文档化；有据的是侦察案例 + 学出来的编排策略本身。
- "根据工作流中的能力需求构建每个工蜂的能力"→ 最接近的官方语句是"按 query 推理数量/时机/专精"与 K2.6 "按技能画像匹配任务"（后者是 BYO 异构 agent 场景，勿混）。**不存在"每阶段能力需求表"这种公开产物。**
- "再派出"的"能力"= 同一冻结 checkpoint + 生成的任务提示词/persona，**不是** per-task 训练的专属模型。
- 结论：你的三点理解方向正确（确实是"任务推导队伍"），但机制是**训练期习得 + 推理期即时铸造**，而非显式四步流水线。

## 4. MAGI swarm 层重设计结论（能学什么、怎么学）

**边界诚实声明：** 我们没有训练环境，PARL 的"学会编排"不可复制。可复制的是**行为等价物**：把"学出来的推导"实现为引擎内的**显式规划 pass**（LLM 工件分析 + 确定性装配），并把 Kimi 的工程机制（PR#424 那一层是完整公开的）原样做成真引擎。G1 spike 已证明前提：插件工具内 `session.create + await session.prompt`（可带 per-request 模型覆盖、Promise.all 并行、headless 自终止）——**不依赖 team-mode，不受 NO-GO 约束**。

**三段流水线（Kimi 工作流铸造式）：**
1. **PLAN**：orchestrator pass 读取工件/目标 → 产出 workflow schema（阶段列表，每阶段声明能力需求：领域、输入形态、判定视角、规模预算）。
2. **MINT**：每阶段按需铸造 worker spec——名字、persona 提示词、模型（从配置的模型池按次选，仿 `[secondary_model]`）、轮预算、超时。名单是推导结果，不是常量。
3. **DISPATCH/AGGREGATE**：引擎驱动分批扇出（并发上限 K、错峰、逐任务超时、限流→suspend、同 worker 重试、未完成按 id resume、有序聚合）；**上下文分片**：worker 只回结论摘要+文件引用，全文走磁盘。

**15 个硬编码点的去向**：roster 组成/角色/提示词/模型档位/轮预算 → **运行时推导**；judgeCriteria → **真正接线进 judge brief**；并发 K/超时/路径/team 命名/词表 → **配置化**（消灭死参数与双词表）；裁决词表统一；`round` 由引擎真实推进。
**固定不变的**：MAGI 三贤人表决规则（2/3 多数、平票/缺票/出错→REJECT，fail-closed，用户拍板）；hub 拓扑（Kimi 官方 roadmap 也没有 subagent 互聊，MAGI 不必越界）。

## 5. 对计划的修订

plan v0 中 `src/swarm/` 的 G2-OPEN 由本报告解决：swarm 层 = `magi_swarm` 工具 + 上述三段引擎（engine 复用 spike 的 runPersona 契约），完全独立于 OMO team-mode。计划已更新至 v1（`.omo/plans/magi-plugin.md`，内部工作证据，不随包发布）。
