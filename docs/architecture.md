# Obsidian Review Gate — Architecture and Phase 0 Research

文档日期：2026-08-19<br>
版本：0.1.0

## 1. 目标与非目标

目标是建立一个本地、Agent 无关、可恢复的写入审批层：

```text
Agent → obsreview CLI → Pending Review → Obsidian Review UI → Approve → Vault
```

非目标：AI Chat、模型 API、Prompt 管理、Agent 管理、MCP Server、RAG、Git UI、云同步、账号和团队权限。

## 2. Phase 0：现有项目调查

调查只提取局部设计经验。除 `jsdiff` 算法适配外，本项目没有复制下表所列 Obsidian 插件源码。

| 项目 | 调查位置 | 可借鉴能力 | License | 直接复用 | 本项目处理 |
|---|---|---|---|---:|---|
| Drift | `ryanbbrown/obsidian-drift`；`src/DiffView.ts`、`src/foldUnchanged.ts`、`src/main.ts`、`src/patienceDiff.ts` | CM6 diff view、外部改动检测、chunk 级操作、未变区折叠 | 0BSD | 否 | 学习 UI/CM6 边界；独立实现 Review 对象、proposal-first 和 hash gate |
| AI Co-Editor | `kebl3541/Obsidian-AI-Co-Editor`；`src/inline.ts`、`src/marks.ts`、`src/merge.ts`、`src/panel.ts` | inline marks、编辑器 decorations、协作变更显示 | MIT | 否 | 使用公开 CM6 state/view API独立实现 proposal editor decorations |
| AI Editor | `dsebastien/obsidian-ai-editor`；`docs/command-line.md` | Obsidian CLI subcommands、JSON 输出、typed error surface | MIT | 否 | 借鉴“机器输出必须稳定”；不依赖 Obsidian CLI，CLI 在 Obsidian 关闭时也可运行 |
| VaultForgian | `KK1182112KK/vaultforgian`；`src/agent/`、`src/app/`、`src/model/`、`src/views/` | patch-before-write、approval panel、权限模式 | MIT | 否 | 独立实现 proposal 持久化、Approve 前 target 不变 |
| Agent MCP | `rospaans/obsidian-agent-mcp`；`src/nodeApi.ts`、`src/main.ts`、`src/tools/` | 外部进程与 Obsidian 的本地桥接方式 | MIT | 否 | 只比较通信边界；不引入 MCP、terminal 或 Agent runtime |
| Coder Engram | 提示中提供的名称；截至文档日期未能从公开来源唯一定位到对应仓库 | 请求中描述的 pending/edit/apply/discard/destination metadata 模式 | 未确认 | 否 | 仅将该模式作为需求语义；不声称研究到具体源码，不复制代码 |

### License 决策

- 上述已识别项目均只学习思想，没有复制代码，因此不进入第三方代码 notice。
- 唯一实际适配代码为 `jsdiff 9.0.0 src/diff/base.ts` 的 Myers edit-graph 核心，BSD-3-Clause；版权与完整许可保存在 `packages/core/src/vendor/jsdiff/LICENSE` 和 `THIRD_PARTY_NOTICES.md`。
- 对无法确认来源或 License 的内容采取零复制策略。

## 3. 通信方案比较

### 3.1 共享文件 + watcher

优点：

- CLI 与 Obsidian 不需要同时运行；
- 状态天然可恢复；
- Windows/macOS/Linux 都有成熟文件系统语义；
- Agent 只需执行普通 CLI；
- 不需要端口、token、服务生命周期；
- `wait` 可以使用文件事件而非高频轮询。

风险：

- 必须处理 atomic save、重复事件、debounce、半写 metadata；
- 需要锁、revision 和安全路径解析；
- watcher 不能作为一致性权威。

### 3.2 localhost HTTP / IPC

优点：请求/响应直接、通知容易、可以集中验证。

风险：Obsidian 必须运行；需要端口发现、token、127.0.0.1 绑定、服务重启和 Windows 防火墙处理；服务内存状态若未持久化仍无法恢复。

### 3.3 Obsidian CLI command

优点：与 Obsidian 官方 CLI 入口统一，终端体验好。

风险：依赖特定 Obsidian 版本与运行状态；CLI 是 Agent 的核心协议时会与 Obsidian 生命周期耦合；无法满足“Obsidian 未启动仍可 submit/status”的强需求。

### 3.4 第一版选择

选择 **共享文件 + watcher**。

事实源是 `.obsreview`，而不是 UI 内存：

```text
CLI ─┐
     ├── .obsreview persistent state ── Obsidian plugin
UI  ─┘
```

插件与 CLI 调用同一个 core 领域服务，因此不存在两套状态机。

## 4. 模块边界

### Core

Core 不依赖 Obsidian API，负责：

- Review/Change model；
- 状态机；
- SHA-256；
- diff/hunk/inline；
- proposal mutation；
- base conflict；
- conservative rebase；
- storage、atomic metadata、lock、event；
- path safety；
- transaction apply/recovery；
- stable domain errors。

### CLI

CLI 只负责：

- 参数解析；
- manifest 文件解析；
- 调用 core service；
- 一行 JSON / 人类可读 JSON；
- stable exit code；
- SIGINT 与 wait timeout。

### Obsidian Plugin

插件负责：

- Review Gate workspace view；
- pending/conflicted/history 列表；
- unified/split DOM diff；
- CodeMirror 6 proposal editor；
- hunk navigation/actions；
- confirm modals；
- filesystem/vault event watcher；
- UI 刷新与 Notice。

插件不重新实现 core 规则。

## 5. Review 与 Change

Review 是一级持久化对象，具有 ULID-like 26 字符 ID 和 monotonic revision。

```ts
interface Review {
  schemaVersion: 1;
  id: string;
  status: "pending" | "approved" | "rejected" | "conflicted" | "cancelled";
  revision: number;
  createdAt: string;
  updatedAt: string;
  source?: { agent?: string; session?: string };
  changes: ReviewChange[];
}
```

Change 从第一版支持：

```text
create / modify / delete / rename
```

`baseContent` 是不可变提交快照；`proposalContent` 是 Review 期间唯一可变内容。

## 6. Proposal-first 语义

允许的 pending mutation：

```text
CLI update
human Edit Proposal
Accept Hunk
Reject Hunk
Rebase
```

这些操作只改变：

```text
.obsreview/pending/<id>/changes/<change-id>/proposal.md
meta.json revision/hash/decisions
```

不允许写 target。

Hunk reject 使用 hunk 中记录的 proposal interval 和 base segment，生成新的 proposal。Hunk accept 记录 decision，但 proposal 内容本身保持不变。任何 proposal 整体更新都会清空旧 hunk decisions，因为 hunk ID 基于 base/proposal 内容。

## 7. Diff 设计

Core 接口：

```ts
interface DiffEngine {
  diff(base: string, proposal: string, options?: DiffOptions): DiffResult;
}
```

实现：

1. Myers token sequence diff；
2. Markdown 行级 token 生成 edit blocks；
3. 合并上下文形成 hunks；
4. 对成对 remove/add 行做 word/space/punctuation token inline diff；
5. UI 只依赖项目自己的 `DiffResult`，不暴露第三方结构。

没有自行编写一个未经验证的 LCS；适配了成熟的 jsdiff Myers 核心，并用 deterministic fuzz test 验证可重建两侧输入。

## 8. CodeMirror 6

Proposal Edit Modal 使用公开：

```text
@codemirror/state
@codemirror/view
StateField
StateEffect
Decoration
EditorView.updateListener
```

Split 模式创建只读 Base 与可编辑 Proposal 两个 EditorView；Unified 模式创建可编辑 Proposal View。行级和 inline decorations 来自 core diff。没有直接操作 CM 私有 DOM 或 Obsidian 私有 editor internals。

若运行环境无法解析公开 CM6 模块，兼容层隔离失败并回退 textarea；Review 页面的 unified/split/hunk diff 仍可使用，安全语义不受影响。

## 9. Watcher 语义

### Proposal/meta watcher

监听 pending 与 history。对 atomic rename、多事件突发做 debounce；外部 proposal 写入会在 service load 时 reconcile：

- 重新计算 proposal hash；
- 清空 stale hunk decisions；
- revision + 1；
- 更新 metadata；
- 刷新 UI。

### Target watcher

Obsidian Vault `create/modify/delete/rename` 事件匹配 pending target 后调用 `markPotentialConflict`。

它只产生 advisory warning：

```text
Watcher is advisory; hash verification is authoritative.
```

Approve 不信任 watcher 的“未发现冲突”结论。

## 10. Concurrency

每个 Review 使用目录锁：

```text
.obsreview/state/locks/<review-id>.lock/
└── owner.json
```

锁包含 pid、hostname、token、createdAt。stale lock 只在超过阈值或本机进程确实不存在时回收。

特别处理 `mkdir(lock)` 与 `owner.json` 写入之间的 acquisition window：竞争者看到暂时缺少 owner 文件时，不能立即删除活锁。该问题有专门并发测试。

所有 proposal/status mutation 支持 `expectedRevision`，防止：

- 两个 Agent update 静默覆盖；
- Agent 覆盖人工编辑；
- approve/cancel 竞态；
- 重复 approve。

多个 `wait` 只读同一 event/status，可同时工作。

## 11. 路径安全

拒绝：

- `..`；
- absolute path；
- Windows drive/UNC path；
- `.obsreview` 自身路径；
- symlink/junction 逃逸；
- case-normalization 后越界；
- rename destination 冲突。

实现不是字符串 `startsWith`。它解析真实 Vault root、逐级检查现有祖先的 realpath，并验证最终路径仍属于 Vault。

## 12. Approve 事务

正常流程：

```text
lock review
  → reconcile proposal
  → expected revision check
  → authoritative preflight for every change
  → stage every output
  → write prepared journal
  → re-verify immediately before each commit
  → safe rename/replace or project trash
  → verify all resulting hashes
  → persist approved metadata
  → move review to history
  → preserve backups
  → mark journal durable/cleanup
  → write event for waiters
```

Modify 的替换流程避免直接 `writeFile(target)`：

```text
stage proposal
rename old target → transaction backup
rename stage → target
fsync parent
verify hash
```

Windows 上 rename/replace 的细节通过显式 backup 路径处理，而不是假设 POSIX overwrite 语义。

## 13. 多文件事务边界

文件系统通常不能提供跨多个任意路径的数据库式 ACID transaction。因此本实现保证：

- Apply 前验证所有 change；
- 先 staging 所有输出；
- transaction journal 持久化；
- 提交中再次验证；
- 任一失败执行 best-effort rollback；
- 记录 committed change IDs 与 rollback errors；
- 启动时根据 journal 恢复。

不能诚实保证的是“断电条件下多个目录 rename 在硬件层绝对同时生效”。当 recovery 无法安全完成时，系统停止自动写入并报告人工恢复，而不是假装成功。

## 14. Conflict 与 Rebase

### Authoritative conflict

Modify/delete/rename：

```text
SHA-256(current) must equal baseHash
```

Create：target 必须仍不存在。Rename：destination 必须仍不存在。

任一 change 冲突时，正常 Apply 不开始。

### Three-way context

UI/CLI 可获取：

```text
Base / Current / Proposal
```

### Conservative rebase

自动 rebase 只合并 base→current 与 base→proposal 的不重叠行级修改。重叠编辑返回 `REBASE_CONFLICT`，不静默猜测。

### Force

显式 force 绕过 base mismatch，但仍执行 staging、journal、result verification，并保存 overwritten content。UI 有二次危险确认。

## 15. Delete 与 History

Delete 不永久销毁：target 被移动到：

```text
.obsreview/trash/<review-id>/<target>
```

Approved/rejected/cancelled Review 移入 history，保留：

- base；
- 最终 proposal；
- base/proposal/result hashes；
- source；
- decision/actor/time；
- conflict/partial failure 信息。

## 16. Crash Recovery

持久化状态不只存在于内存。启动时扫描 transaction journals：

- 未完成 apply：尝试 rollback；
- metadata 已 durable approved：保留 backup 后 cleanup；
- 无法确定：标记 manual recovery，CLI/UI 不继续自动写入。

Metadata 自身采用 temp + close/fsync + atomic rename。

## 17. 性能策略

- 只 diff 当前 change，不扫描整个 Vault；
- watcher debounce；
- core diff 有 timeout/max-edit safety limit；
- CM6 decoration 对 base+proposal 超过约 1 MB 时关闭，避免输入时同步重算长时间阻塞；
- history/list 使用轻量 metadata；
- `.obsreview` 从普通文件导航中隐藏。

未来可把超大文件 diff 放入 Worker，但这不是安全正确性的前提。

## 18. 关键设计选择结论

1. **共享持久化目录优于 localhost server**：减少生命周期、鉴权和端口复杂度，CLI 可离线工作。
2. **Review 是一级对象**：自然支持多文件、历史、revision、source 和 transaction。
3. **proposal 是唯一可变层**：避免人工 layer、Agent layer、hunk layer 叠加造成语义混乱。
4. **hash gate 是权威**：watcher 仅改善提示延迟。
5. **全量 preflight + journal**：在普通文件系统上给出可解释、可恢复的最强实际保证。
6. **窄 core 接口**：CLI 和 Obsidian UI 共享同一规则，core 完全可单测。
