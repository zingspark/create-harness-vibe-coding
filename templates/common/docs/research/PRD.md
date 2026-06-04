# PRD: {{projectName}}

> **读者**：AI + 未来的你。不是给 PM 审批用的，是给实现和审查用的。
> **原则**：不超过一页。用 checkbox，不用散文。负面定义 > 正面定义。
>
> 哲学来源：Miqdad Jaffer (OpenAI) 的 AI 时代精益 PRD 模板。

---

## 1. 为什么做

{{WHY_THIS_PROJECT_EXISTS}}

## 2. MVP 边界

### v0.1 必须能做

- [ ] {{MUST_1}}
- [ ] {{MUST_2}}
- [ ] {{MUST_3}}

### 明确不做

- {{NON_GOAL_1}}
- {{NON_GOAL_2}}
- {{NON_GOAL_3}}

## 3. 决策优先级

1. **安全边界** — 不允许绕过权限、安全门和审计。
2. **架构边界** — 不允许让 domain 依赖 harness/infrastructure/interfaces，也不让 harness 承担领域判断。
3. **可验证性** — 新行为必须有测试或明确的人工验证记录。
4. **正确性** — 行为符合设计文档、端口合同、数据流和状态机。
5. **简洁性** — 最少代码解决当前 MVP，不为未来场景预埋抽象。

## 4. 用户与使用场景

| 用户角色 | 核心场景 | 频率 | 痛点 |
| --- | --- | --- | --- |
| {{USER_ROLE_1}} | {{SCENARIO}} | {{FREQUENCY}} | {{PAIN}} |
| {{USER_ROLE_2}} | {{SCENARIO}} | {{FREQUENCY}} | {{PAIN}} |

## 5. 验收标准

- [ ] {{ACCEPTANCE_1}}
- [ ] {{ACCEPTANCE_2}}
- [ ] {{ACCEPTANCE_3}}

## 6. 非功能性需求

| 维度 | 目标 | 测量方式 |
| --- | --- | --- |
| {{DIMENSION_1}} | {{TARGET}} | {{MEASUREMENT}} |
| {{DIMENSION_2}} | {{TARGET}} | {{MEASUREMENT}} |

---

## 填充完成标准

- [ ] MVP 和 Non-goals 都是项目事实，不保留 `{{...}}` 占位符。
- [ ] 决策优先级能指导 tradeoff，而不是泛泛而谈。
- [ ] 每条验收标准都能被测试、命令或人工步骤验证。
- [ ] 如果实现偏离 PRD，先更新本文件再改代码。
