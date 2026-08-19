# `obsreview` CLI / JSON Protocol 0.1

## 1. General rules

- UTF-8 input/output。
- `--json` 时 stdout 只写一个单行 JSON 文档并以 `\n` 结束。
- 错误同样输出 JSON，不把 stack trace 混入协议 stdout。
- Vault 可由 `--vault` 或 `OBSREVIEW_VAULT` 提供；显式 flag 优先。
- ID：Review 为 26 字符 Crockford-base32 sortable ID；Change 为 `0001`、`0002`……。
- 时间：UTC ISO-8601 string。
- Hash：lowercase SHA-256 hex。

## 2. Success envelope

Review 命令的基本返回：

```json
{
  "ok": true,
  "reviewId": "01M0C33XDHFTNHZ2WMG1N05E4B",
  "status": "pending",
  "revision": 1,
  "createdAt": "2026-08-19T00:00:00.000Z",
  "updatedAt": "2026-08-19T00:00:00.000Z",
  "source": {
    "agent": "codex",
    "session": "task-42"
  },
  "changes": [
    {
      "id": "0001",
      "operation": "modify",
      "target": "Framework/CAN.md",
      "baseHash": "...",
      "proposalHash": "...",
      "resultHash": null
    }
  ]
}
```

可选字段：`source`、`conflict`、`decision`、`partialFailure`、`transactionId`、`maintenancePending`。

## 3. Failure envelope

```json
{
  "ok": false,
  "code": "REVISION_CONFLICT",
  "message": "Expected revision 4 but found 5.",
  "details": {
    "expectedRevision": 4,
    "actualRevision": 5
  }
}
```

`code` 是脚本分支依据；`message` 面向日志；`details` 只含结构化诊断。

## 4. Exit codes

| Code | Meaning |
|---:|---|
| 0 | success |
| 1 | general, I/O, lock, recovery or internal error |
| 2 | invalid arguments / target path |
| 3 | review/change not found |
| 4 | review/revision/rebase conflict |
| 5 | rejected terminal result |
| 6 | cancelled terminal result |
| 7 | wait timeout |
| 130 | SIGINT |

## 5. Error codes

Core/CLI 可返回的稳定类别包括：

```text
INVALID_ARGUMENTS
INVALID_TARGET_PATH
REVIEW_NOT_FOUND
CHANGE_NOT_FOUND
INVALID_STATE_TRANSITION
REVIEW_NOT_MUTABLE
REVISION_CONFLICT
REVIEW_CONFLICT
REBASE_CONFLICT
HUNK_NOT_FOUND
LOCK_TIMEOUT
WAIT_TIMEOUT
CORRUPTED_REVIEW
IO_ERROR
INTERNAL_ERROR
```

调用方必须容忍未来新增 code；未知 code 按 general error 处理。

## 6. Manifest schema

```json
{
  "agent": "codex",
  "session": "task-42",
  "changes": [
    {
      "operation": "modify",
      "target": "Framework/CAN.md",
      "file": "can.md"
    },
    {
      "operation": "create",
      "target": "Framework/SPI.md",
      "content": "# SPI\n"
    },
    {
      "operation": "delete",
      "target": "Old/Deprecated.md"
    },
    {
      "operation": "rename",
      "target": "Old/UART.md",
      "newTarget": "Framework/UART.md",
      "file": "uart.md"
    }
  ]
}
```

Rules：

- `changes` 必须非空；
- operation 可为 `auto/create/modify/delete/rename`；
- `file` 相对 manifest 目录；
- `file` 与 `content` 互斥；
- delete 无 proposal；
- rename 要求 `newTarget`；
- 所有 target 经 Vault containment 验证。

## 7. Optimistic revision

所有会改变 Review 的外部调用应携带上一次读取的 revision：

```bash
--expected-revision <n>
```

冲突时不执行 mutation，返回退出码 4 与 `REVISION_CONFLICT`。这是 Agent 与人工编辑并存的协议要求，而不是可选优化。

## 8. Wait semantics

`wait` 首先读取当前状态：若已 terminal/conflicted，立即返回；否则订阅 review event/status 文件变化。

唤醒条件：

```text
approved / rejected / cancelled / conflicted
```

多个 waiter 可以同时存在。Watcher 丢事件时，状态文件仍是事实源；事件只负责唤醒。

## 9. Compatibility policy

`schemaVersion: 1` 和 CLI protocol `0.1` 内：

- 不删除现有字段；
- 新字段必须是可选；
- 不改变既有退出码语义；
- 不让 human-readable 输出影响 JSON 模式；
- metadata schema 迁移必须显式实现，不能静默猜测未知版本。
