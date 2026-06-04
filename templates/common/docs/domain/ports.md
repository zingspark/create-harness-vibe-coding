# 端口协议 — {{projectName}}

> **职责**：定义跨层接口契约。这是分层架构的"法律合同"。每个端口不仅写签名，还写前置条件、后置条件、错误语义。
>
> **原则**：端口文档 != API 参考文档。它是一个合同（contract），指定调用方义务和实现方保证。
>
> 哲学来源：Bertrand Meyer 的 Design by Contract (Eiffel) + Alistair Cockburn 的六边形架构端口文档。

---

## 1. 端口分类

### 1.1 驱动端口（Inbound — 外部调用应用）

| 端口 | 定义位置 | 用途 |
| --- | --- | --- |
| `{{INBOUND_PORT_1}}` | `{{LOCATION}}` | {{DESCRIPTION}} |

### 1.2 被驱动端口（Outbound — 应用调用外部）

| 端口 | 定义位置 | 用途 |
| --- | --- | --- |
| `{{OUTBOUND_PORT_1}}` | `{{LOCATION}}` | {{DESCRIPTION}} |

---

## 2. 端口定义模板

每个端口按以下格式填写：

- **类别**：驱动 / 被驱动
- **定义位置**：`{{FILE_PATH}}`
- **协议类**：`{{CLASS_OR_INTERFACE}}`

### 用途

{{WHAT_THIS_PORT_DOES}}

### 方法

**前置条件**（调用方必须保证）：
- {{PRECONDITION_1}}
- {{PRECONDITION_2}}

**后置条件**（实现方保证）：
- {{POSTCONDITION_1}}
- {{POSTCONDITION_2}}

**错误语义**：

| 异常类型 | 触发条件 | 调用方应 |
| --- | --- | --- |
| `{{EXCEPTION_TYPE}}` | {{CONDITION}} | {{CALLER_ACTION}} |

**幂等性**：{{YES_NO_AND_DETAILS}}

### 已知实现

| 适配器 | 位置 | 用途 |
| --- | --- | --- |
| `{{ADAPTER_NAME}}` | `{{LOCATION}}` | {{PURPOSE}} |

---

## 3. 跨端口不变量

- {{INVARIANT_1}}
- {{INVARIANT_2}}
- 新增端口必须定义在 `domain/ports` 中，适配器放在 `infrastructure/`。

---

> **提示**：当前 ports.md 是模板。请根据你的项目领域替换 `{{...}}` 占位符。参考 `docs/harness/data-flow.md` 了解端口如何被编排。
