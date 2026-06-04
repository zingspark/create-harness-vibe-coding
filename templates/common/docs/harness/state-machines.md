# 状态机 — {{projectName}}

> **职责**：定义所有有状态组件的状态、转移、守卫条件、边界行为。长流程 harness 的大量 bug 来自非法状态转移。
>
> 哲学来源：UML 2.5.1 第 15.3.14 节 + "转移表是整个文档最重要的产物"。

---

## 状态机模板

每个有状态组件按此格式填写：

### 状态枚举

| 状态 | 描述 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `{{STATE_1}}` | {{DESCRIPTION}} | {{CONDITION}} | {{CONDITION}} |
| `{{STATE_2}}` | {{DESCRIPTION}} | {{CONDITION}} | {{CONDITION}} |

### 状态转移图

```mermaid
stateDiagram-v2
    [*] --> {{INITIAL_STATE}}
    {{INITIAL_STATE}} --> {{STATE_2}} : {{TRIGGER}}
    {{STATE_2}} --> {{INITIAL_STATE}} : {{TRIGGER}}
```

### 转移表（最重要）

| 当前状态 ↓ / 事件 → | `{{EVENT_1}}` | `{{EVENT_2}}` | `{{EVENT_3}}` |
| --- | --- | --- | --- |
| **`{{STATE_1}}`** | {{TARGET}} | {{TARGET}} | {{TARGET}} |
| **`{{STATE_2}}`** | {{TARGET}} | {{TARGET}} | {{TARGET}} |

### 守卫条件

| 转移 | 守卫条件 | 备注 |
| --- | --- | --- |
| `{{SOURCE}} -> {{TARGET}}` | {{GUARD}} | {{NOTE}} |

### 非法转移

| 转移 | 为什么非法 |
| --- | --- |
| `{{SOURCE}} -> {{TARGET}}` | {{REASON}} |

---

> **提示**：当前 state-machines.md 是空模板。请按项目实际的有状态组件填写。
