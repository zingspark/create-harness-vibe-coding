# {{FEATURE_NAME}}

> **状态**：Draft / In Progress / Blocked / Done
> **创建日期**：{{YYYY-MM-DD}}
> **负责人**：{{OWNER_OR_AGENT}}
> **关联文档**：{{PRD_OR_ARCH_DOC_LINKS}}

---

## 1. Requirements

### 1.1 背景

{{WHY_THIS_FEATURE_EXISTS}}

### 1.2 目标

- {{GOAL_1}}
- {{GOAL_2}}

### 1.3 非目标

- {{NON_GOAL_1}}
- {{NON_GOAL_2}}

### 1.4 验收标准

- [ ] {{ACCEPTANCE_CRITERION_1}}
- [ ] {{ACCEPTANCE_CRITERION_2}}
- [ ] {{ACCEPTANCE_CRITERION_3}}

---

## 2. Design

### 2.1 影响范围

| 区域 | 是否影响 | 说明 |
| --- | --- | --- |
| `harness/architecture.md` | {{YES_NO}} | {{NOTE}} |
| `domain/ports.md` | {{YES_NO}} | {{NOTE}} |
| `harness/data-flow.md` | {{YES_NO}} | {{NOTE}} |
| `harness/state-machines.md` | {{YES_NO}} | {{NOTE}} |
| tests | {{YES_NO}} | {{NOTE}} |

### 2.2 Allowed Write Set

- `{{PATH_OR_GLOB_1}}`
- `{{PATH_OR_GLOB_2}}`

### 2.3 Forbidden Scope

- `{{PATH_OR_BEHAVIOR_1}}`
- `{{PATH_OR_BEHAVIOR_2}}`

### 2.4 方案

#### 候选方案

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| {{OPTION_A}} | {{PROS_A}} | {{CONS_A}} | {{ACCEPT_REJECT}} |
| {{OPTION_B}} | {{PROS_B}} | {{CONS_B}} | {{ACCEPT_REJECT}} |

#### 选择理由

{{SELECTED_DESIGN_AND_RATIONALE}}

### 2.5 边界条件

- {{EDGE_CASE_1}} -> {{EXPECTED_BEHAVIOR_1}}
- {{EDGE_CASE_2}} -> {{EXPECTED_BEHAVIOR_2}}

---

## 3. Tasks

> 每个 task 必须有验证方式。需要 subagent 时，先写清角色和 write set。

| # | Task | Owner | Write Set | Verify |
| --- | --- | --- | --- | --- |
| 1 | {{WRITE_FAILING_TEST_OR_DOC_CHECK}} | {{OWNER}} | `{{PATH}}` | `{{COMMAND_OR_CHECK}}` |
| 2 | {{IMPLEMENT_MINIMAL_CHANGE}} | {{OWNER}} | `{{PATH}}` | `{{COMMAND_OR_CHECK}}` |
| 3 | {{SYNC_DOCS_OR_BOUNDARIES}} | {{OWNER}} | `{{PATH}}` | `{{COMMAND_OR_CHECK}}` |

### Subagent Plan

| Role | Needed? | Scope |
| --- | --- | --- |
| Explorer | {{YES_NO}} | {{READ_ONLY_SCOPE}} |
| Test Writer | {{YES_NO}} | {{TEST_WRITE_SET}} |
| Implementer | {{YES_NO}} | {{IMPLEMENTATION_WRITE_SET}} |
| Reviewer | {{YES_NO}} | {{REVIEW_SCOPE}} |
| Verifier | {{YES_NO}} | {{VERIFY_COMMANDS}} |

---

## 4. Verification

### 4.1 Test Results

| Command | Result | Notes |
| --- | --- | --- |
| `{{TEST_COMMAND}}` | {{PASS_FAIL_NOT_RUN}} | {{NOTES}} |
| `{{OTHER_COMMAND}}` | {{PASS_FAIL_NOT_RUN}} | {{NOTES}} |

### 4.2 Review Findings

- {{FINDING_OR_NONE}}

### 4.3 Docs Sync

- [ ] `harness/architecture.md`
- [ ] `domain/ports.md`
- [ ] `harness/data-flow.md`
- [ ] `harness/state-machines.md`
- [ ] `research/scaffolds.md`
- [ ] Not needed because {{REASON}}

### 4.4 Decision Log

| Date | Decision | Reason |
| --- | --- | --- |
| {{YYYY-MM-DD}} | {{DECISION}} | {{REASON}} |

### 4.5 Closeout

- [ ] Acceptance criteria satisfied.
- [ ] Tests or manual verification recorded.
- [ ] Boundary impact documented.
- [ ] Remaining risks listed or explicitly none.
- [ ] If docs/code/tests conflicted, Decision Log records how it was resolved.

Remaining risks:
- {{RISK_OR_NONE}}
