# Agent Workflow Harness

> **职责**：约束 agent 如何实现一个功能。它不是 runtime 代码架构，而是 engineering harness：防止 AI 跳过需求、乱改边界、缺测试、没有闭环。
>
> **原则**：小任务轻流程，大任务有文档；用测试和边界检查约束 agent，而不是靠长提示词。

---

## 1. 什么时候必须开 Feature Doc

使用 [../features/_template.md](../features/_template.md) 创建一个新的 `docs/features/{{FEATURE_SLUG}}.md`。

必须开文档：
- 新增功能或用户可见行为。
- 修改跨层契约、端口、状态机、数据流或权限规则。
- 影响多个模块，或预计超过一个短会话。
- 修复边界不清的 bug，需要先定义期望行为。
- 需要 subagents 分工、TDD 或人工审批。

可以不开文档：
- 拼写、链接、注释等纯文档小修。
- 单测试断言或单行安全修复，且边界完全清楚。
- 只读调查或一次性命令输出。

如果不确定，开一个短 feature doc。短文档比隐含假设便宜。

---

## 2. Kiro-lite 流程

每个非平凡功能按一个文件走完四段，不默认拆多个文件。

1. **Requirements**：写清目标、非目标、验收标准。
2. **Design**：写清影响范围、允许修改文件、不允许修改文件、接口/状态/数据流变化。
3. **Tasks**：拆成可验证任务，每个任务有 owner、write set、验证命令。
4. **Verification**：记录测试结果、边界检查、文档同步、剩余风险。

只有当 feature doc 超过约 200 行，或任务需要多人/多 agent 长时间并行时，才升级为目录：

```text
docs/features/{{FEATURE_SLUG}}/
├── requirements.md
├── design.md
├── tasks.md
└── verification.md
```

---

## 3. Subagent 分工

Subagent 是分工工具，不是责任转移。主 agent 负责最终集成、验证和解释。

| 角色 | 允许做 | 禁止做 | 输出 |
| --- | --- | --- | --- |
| Explorer | 只读调查、找上下文、列风险 | 修改文件、重构、下结论替代验证 | 相关文件、风险点、建议测试 |
| Test Writer | 只写/改测试和测试 fixtures | 改生产代码、放宽断言 | 失败测试、测试意图 |
| Implementer | 在指定 write set 内实现 | 触碰未授权文件、扩大 scope | 改动文件、实现说明 |
| Reviewer | 只读审查边界、过度设计、缺测试 | 修改代码、重排任务 | findings、severity、文件行号 |
| Verifier | 运行验证命令、汇总结果 | 改业务代码掩盖失败 | 命令、结果、失败原因 |

分工规则：
- 同一时间并行 subagents 的 write set 必须不重叠。
- Explorer 和 Reviewer 默认只读。
- Test Writer 必须先于 Implementer，除非是纯文档或无法自动测试的变更。
- Implementer 只能执行 feature doc 里列出的 tasks。
- Verifier 的失败结果必须写回 feature doc，不能只在聊天里口头说明。

---

## 4. TDD 闭环

默认闭环：

```text
feature doc -> failing test -> minimal implementation -> tests pass -> boundary check -> docs sync -> review -> close
```

TDD 规则：
- 新行为先写失败测试，再实现。
- bug fix 先写复现测试，再修复。
- 重构先记录现有测试，再移动代码，最后证明行为未变。
- 无法自动测试时，feature doc 必须写明人工验证步骤和不可自动化原因。
- 不允许为了通过测试删除关键断言、放宽边界测试或跳过失败测试。

---

## 4.1 矛盾处理

当 agent 发现 PRD、architecture、ports、data-flow、state-machines、tests 或代码互相矛盾时：

1. 停止实现，不继续猜测。
2. 在 feature doc 的 Decision Log 记录冲突位置、冲突内容、可选解释和推荐选择。
3. 如果冲突影响安全边界、端口合同、状态机或用户可见行为，先询问维护者。
4. 如果冲突只影响命名、注释或明显过期文档，可以按代码和测试事实修正 docs，并在 Verification 记录原因。
5. 修正后再继续 TDD 闭环。

---

## 5. Write Set 和边界

Feature doc 必须写：
- **Allowed write set**：本次允许修改哪些文件/目录。
- **Forbidden scope**：明确不碰哪些文件/行为。
- **Architecture impact**：是否影响 `architecture.md`、`ports.md`、`data-flow.md`、`state-machines.md`。
- **Rollback note**：失败时如何回退本次改动，不要求回退用户已有改动。

默认禁止：
- 顺手重构无关模块。
- 为了实现一个功能修改公共契约但不更新 docs。
- 让 harness 承担 domain 业务判断。
- 绕过权限、审计、状态机和边界测试。

---

## 6. 完成标准

一个 feature 只有同时满足这些条件才算完成：
- Requirements 的验收标准逐条可验证。
- Tasks 全部完成或明确取消并说明原因。
- 新增/修改行为有测试或人工验证记录。
- 测试框架（如 pytest、vitest、go test）通过；如果不能通过，记录具体失败和是否与本次变更相关。
- 架构边界测试通过，或 feature doc 记录为什么需要改变边界。
- 受影响 docs 已同步。
- Reviewer 没有未处理的 critical/high findings。

## 6.1 快车道

满足以下全部条件时，可以不开完整 feature doc，但必须在提交说明或聊天结果里写清验证：

- 只影响拼写、链接、注释、单个测试断言或单行安全修复。
- 不改变跨层端口、状态机、数据流、权限、审计或用户可见行为。
- 不新增依赖，不移动文件，不扩大 public API。
- 能用一个命令或一次人工检查验证。

如果快车道过程中发现影响范围变大，立即补 feature doc。

---

## 7. 外部参考

- OpenAI ExecPlans：复杂任务要有自包含、可恢复、可验证的执行计划。
- GitHub Spec Kit：constitution -> specify -> plan -> tasks -> implement。
- Kiro Specs：requirements -> design -> tasks，适合约束 agent 先想清楚再写代码。
- Claude Code Subagents / Hooks：focused subagents、权限限制、hook-based guardrails。
