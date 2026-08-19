# Obsidian Review Gate

**Obsidian Review Gate** 是一个本地、Agent 无关的 Obsidian 写入审批层。外部 Agent 通过稳定的 `obsreview` CLI 提交 proposal；正式 Vault 文件只有在人工 Review 并执行 **Approve** 后才会被修改。

```text
Agent
  ↓
obsreview submit
  ↓
external review storage / pending / <review-id>
  ↓
Obsidian Review Gate
  ↓
review / edit proposal / accept or reject hunk
  ↓
approve-time hash verification
  ↓
Vault
```

它不是 AI Chat、Copilot、MCP Server 或 Agent 管理器。它只负责 **Review / Transaction / Approval**。

## 当前版本

- 版本：`0.1.2`
- Obsidian：桌面版，`1.5.0+`
- CLI：Node.js `20+`
- 状态：可通过 GitHub Release / BRAT 安装的公开第一版
- 测试：35 项自动测试、CLI 端到端 smoke、插件单文件加载 smoke、独立发布包解压验收

## 已实现能力

| 能力 | 状态 | 实现摘要 |
|---|---:|---|
| Diff UI | ✅ | Unified / Split、行级与 inline 高亮 |
| Hunk accept / reject | ✅ | 操作 proposal，不触碰 target |
| CLI ↔ Obsidian | ✅ | Vault 外共享持久化目录 + filesystem watcher |
| patch-before-write | ✅ | proposal 先进入系统用户数据目录中的 pending state |
| pending → apply | ✅ | Approve 才进入事务式 apply |
| Conflict / base hash | ✅ | SHA-256，Approve 前权威复验 |
| 文件监听 | ✅ | proposal、metadata/history、target advisory watcher |
| Diff 算法 | ✅ | 适配 jsdiff Myers；行级 hunk + token inline diff |
| 多文件 Review | ✅ | manifest、全量 preflight、staging、journal、rollback |
| Revision / lock | ✅ | review-level directory lock、optimistic revision |
| Crash recovery | ✅ | transaction journal，启动时恢复或报告人工处理 |
| History | ✅ | approved/rejected/cancelled 归档并保留审计内容 |
| Create / Modify / Delete / Rename | ✅ | Delete 进入外部 review trash，Rename 有冲突检查 |
| Conservative rebase | ✅ | 仅自动合并不重叠的行级修改 |
| Explicit force apply | ✅ | UI/CLI 显式危险操作，并保存被覆盖内容的备份 |

## 核心不变量

这些不变量同时写在领域模型注释和架构文档中：

1. `Pending review cannot mutate the target file.`
2. `Hunk operations mutate proposal state, not target state.`
3. `Approve must validate base state again immediately before writing.`
4. `Watcher is advisory; hash verification is authoritative.`
5. `External agents interact through stable CLI/protocol boundaries.`
6. `Review state survives Obsidian/plugin/process restart.`

判断实现是否正确的最终问题是：

> Review 未获批准时，Agent 的 proposal 是否存在正常路径已经修改正式 target？

本实现的答案是：**没有。**

---

# 安装

## 1. 通过 BRAT 安装 Obsidian 插件（推荐）

1. 在 Obsidian 的第三方插件市场安装并启用 **BRAT**；
2. 执行命令 `BRAT: Add a beta plugin for testing`；
3. 输入仓库地址 `https://github.com/CaFeZn/obsidian-review-gate`；
4. 选择最新版本或固定版本 `0.1.2`；
5. 安装完成后启用 **Obsidian Review Gate**。

BRAT 会从 GitHub Release 下载 `main.js`、`manifest.json` 和 `styles.css`。Release tag、Release name 与 `manifest.json` 中的版本必须一致。

## 2. 手工安装 Obsidian 插件

将发布包中的完整目录：

```text
obsidian-review-gate/
├── main.js
├── manifest.json
└── styles.css
```

复制到：

```text
<Vault>/.obsidian/plugins/obsidian-review-gate/
```

然后：

1. 重启或重新加载 Obsidian；
2. 打开 **设置 → 第三方插件**；
3. 启用 **Obsidian Review Gate**；
4. 点击左侧 ribbon 的 Review Gate 图标，或从命令面板执行 `Open Review Gate`。

`LICENSE`、`LICENSES/`、`README.md` 和 `THIRD_PARTY_NOTICES.md` 是随包附带的文档；插件运行所需的核心文件为 `main.js`、`manifest.json` 和 `styles.css`。

## 3. 安装 `obsreview` CLI

解压独立 CLI 包到固定目录，例如：

```text
C:\Tools\obsreview\
```

Windows 可直接执行：

```powershell
C:\Tools\obsreview\obsreview.cmd --version
```

将该目录加入 `PATH` 后可直接使用：

```powershell
obsreview --version
```

macOS / Linux：

```bash
chmod +x /opt/obsreview/obsreview
/opt/obsreview/obsreview --version
```

也可以直接运行：

```bash
node /path/to/obsreview/obsreview.js --version
```

CLI 可通过每条命令的 `--vault` 指定 Vault，或使用环境变量：

```powershell
$env:OBSREVIEW_VAULT = "D:\Notes"
```

```bash
export OBSREVIEW_VAULT=/home/me/Notes
```

Review 协议数据默认保存在目标 Vault 的隐藏目录：

```text
<vault>\.obsreview\
```

CLI 通过 Node 文件系统访问该目录；插件通过 Obsidian `DataAdapter` 访问同一目录，避免在 TSafe 环境中绕过 Obsidian 的受信任读写路径。

---

# 最简工作流

假设正式文件为：

```text
D:\Notes\Framework\CAN.md
```

Agent 已将新内容写入一个临时文件：

```text
C:\Temp\can-new.md
```

## Submit

```powershell
obsreview submit `
  --vault "D:\Notes" `
  --target "Framework/CAN.md" `
  --file "C:\Temp\can-new.md" `
  --agent "codex" `
  --json
```

返回一行 JSON：

```json
{"ok":true,"reviewId":"01M0...","status":"pending","revision":1,"changes":[{"id":"0001","operation":"modify","target":"Framework/CAN.md","baseHash":"...","proposalHash":"...","resultHash":null}]}
```

此时：

- `Framework/CAN.md` 仍是原内容；
- base snapshot 和 proposal 位于 Vault 外的 review storage；
- Obsidian Review Gate 自动显示该 Review。

## Wait

```powershell
obsreview wait 01M0... --vault "D:\Notes" --json
```

`wait` 使用文件事件阻塞等待，不要求 Agent 高频轮询。支持：

```powershell
obsreview wait 01M0... --vault "D:\Notes" --timeout-ms 600000 --json
```

Ctrl+C 返回进程退出码 `130`。

## Human Review

在 Obsidian 中：

- 切换 Unified / Split；
- 上一个 / 下一个 hunk；
- Accept hunk；
- Reject hunk；
- Edit proposal；
- Reject review；
- Approve review。

**Accept hunk** 表示 proposal 中该块保持接受状态；**Reject hunk** 会将 proposal 的相应区间恢复为 base。两者都不会写正式文件。

## Agent Update

先读取 Review：

```powershell
obsreview show 01M0... --vault "D:\Notes" --json
```

再以 optimistic revision 更新 proposal：

```powershell
obsreview update 01M0... `
  --vault "D:\Notes" `
  --change 0001 `
  --file "C:\Temp\can-v2.md" `
  --expected-revision 4 `
  --json
```

若人工编辑已先发生，revision 已改变，CLI 返回：

```json
{"ok":false,"code":"REVISION_CONFLICT","message":"..."}
```

Agent 必须重新 `show`，不能静默覆盖人工修改。

## Approve

Obsidian UI 执行 Approve 时会：

1. 获取 review lock；
2. 重新读取所有 target；
3. 对所有 change 做 base hash / create / rename preflight；
4. staging 全部 proposal；
5. 写 transaction journal；
6. 逐项安全替换；
7. 验证结果 hash；
8. 标记 approved；
9. 移入 history；
10. 通知 `wait`。

`wait` 返回：

```json
{"ok":true,"reviewId":"01M0...","status":"approved","revision":5,"changes":[...]}
```

---

# CLI 命令

所有命令支持 `--json`。JSON 模式严格输出单行文档，适合 Agent 与脚本读取。

## submit

自动判断 create / modify：

```bash
obsreview submit \
  --vault "/path/to/Vault" \
  --target "Framework/CAN.md" \
  --file "/tmp/can-new.md" \
  --agent "claude-code" \
  --session "task-42" \
  --json
```

显式操作：

```bash
--operation auto|create|modify|delete|rename
```

Delete 不需要 `--file`：

```bash
obsreview submit --vault "$VAULT" --target "Old.md" --operation delete --json
```

Rename：

```bash
obsreview submit \
  --vault "$VAULT" \
  --target "Old.md" \
  --new-target "Archive/New.md" \
  --operation rename \
  --file "/tmp/new-content.md" \
  --json
```

## 多文件 manifest

```bash
obsreview submit --vault "$VAULT" --manifest review.json --json
```

示例见 [`examples/review.json`](examples/review.json)。`file` 相对于 manifest 所在目录解析；也可使用内联 `content`，但同一个 change 不能同时指定二者。

## update

```bash
obsreview update <review-id> \
  --vault "$VAULT" \
  --change 0001 \
  --file proposal-v2.md \
  --expected-revision 4 \
  --json
```

保持原 `baseContent` 与 `baseHash`，只替换 proposal，并清空基于旧 proposal 的 hunk decisions。

## status

```bash
obsreview status <review-id> --vault "$VAULT" --json
```

## show

返回完整 base/proposal：

```bash
obsreview show <review-id> --vault "$VAULT" --json
```

冲突上下文：

```bash
obsreview show <review-id> \
  --vault "$VAULT" \
  --conflict-context \
  --json
```

## list

```bash
obsreview list --vault "$VAULT" --json
obsreview list --vault "$VAULT" --status pending,conflicted --json
obsreview list --vault "$VAULT" --location history --json
```

## wait

```bash
obsreview wait <review-id> --vault "$VAULT" --timeout-ms 600000 --json
```

## cancel

```bash
obsreview cancel <review-id> \
  --vault "$VAULT" \
  --expected-revision 2 \
  --actor "codex" \
  --json
```

Cancel 归档 Review，不修改 target。

## 管理/UI 等价命令

这些命令主要用于自动化测试、应急管理和未来 UI 适配；正常 Agent 不应自行批准自己的 Review。

```bash
obsreview approve <review-id> --vault "$VAULT" --expected-revision 3 --actor human --json
obsreview reject  <review-id> --vault "$VAULT" --expected-revision 3 --actor human --json
obsreview rebase  <review-id> --vault "$VAULT" --expected-revision 3 --actor human --json
obsreview hunk    <review-id> --vault "$VAULT" --change 0001 --hunk-id <id> --decision accept|reject --expected-revision 3 --json
```

危险覆盖必须显式使用：

```bash
obsreview approve <review-id> --vault "$VAULT" --force --actor human --json
```

---

# 稳定退出码

| 退出码 | 含义 |
|---:|---|
| `0` | success |
| `1` | general / I/O / internal error |
| `2` | invalid arguments / invalid target path |
| `3` | review or change not found |
| `4` | review, revision, or rebase conflict |
| `5` | rejected |
| `6` | cancelled |
| `7` | wait timeout |
| `130` | Ctrl+C interruption |

失败 JSON：

```json
{
  "ok": false,
  "code": "REVIEW_CONFLICT",
  "message": "Target changed since this proposal was created.",
  "details": {}
}
```

协议详见 [`docs/protocol.md`](docs/protocol.md)。

---

# Conflict 行为

Modify 提交时：

```text
baseHash = SHA-256(target content)
```

Target watcher 发现外部写入时只设置 advisory conflict 标志，以便 UI 尽早提示。它不是安全边界。

Approve 时必定重新读取：

```text
currentContent
currentHash
```

若：

```text
currentHash != baseHash
```

则：

- 拒绝直接 Apply；
- Review 进入 `conflicted`；
- UI 显示 Base / Current / Proposal；
- 多文件 Review 一个冲突即阻止整个正常 Apply；
- 不会用 proposal 覆盖 current。

## Rebase

实现的是保守三方合并：

```text
old base = A
current  = B
proposal = P
```

仅当 `A→B` 与 `A→P` 的行级编辑区间不重叠时生成新的 proposal `P'`，并将 base 刷新为 `B`。有重叠就保持 conflicted，不进行概率性静默合并。

## Force Apply

Force Apply 必须显式确认。被覆盖的 current 内容会进入：

```text
<vault>/.obsreview/trash/<review-id>/.../.backups/
```

---

# 持久化布局

每个 Vault 使用自己的隐藏目录，布局如下：

```text
<vault>/.obsreview/
├── pending/
│   └── <review-id>/
│       ├── meta.json
│       └── changes/
│           ├── 0001/
│           │   ├── base.md
│           │   └── proposal.md
│           └── 0002/
│               ├── base.md
│               └── proposal.md
├── history/
├── state/
│   ├── locks/
│   ├── transactions/
│   └── events/
└── trash/
```

CLI 与插件共享这一个持久化事实源。插件的全部协议与 target I/O 都通过 Obsidian `DataAdapter` 完成；pending review 不会改动正式 target，只有 Approve 会写入正式文件。

Metadata 使用 temp + rename 的安全更新方式，Node 文件系统额外执行 fsync。proposal 外部原子保存会被内容指纹 watcher 或下一次读取 reconcile 到 metadata，并递增 revision。

---

# 架构

```text
packages/
├── core/                 # 不依赖 Obsidian API
│   └── src/
│       ├── model/
│       ├── diff/
│       ├── patch/
│       ├── conflict/
│       ├── storage/
│       ├── path/
│       ├── protocol/
│       └── service/
├── cli/
│   ├── bin/obsreview.cjs
│   └── src/
└── obsidian-plugin/
    ├── src/editor/
    ├── src/ui/
    ├── src/watcher/
    ├── src/main.ts
    ├── manifest.json
    └── styles.css
```

更完整的通信方案比较、事务边界、研究记录和设计理由见 [`docs/architecture.md`](docs/architecture.md)。

---

# 开发

```bash
npm install
npm run typecheck
npm test
npm run build
npm run smoke
npm run plugin-smoke
npm run check
```

`npm run check` 顺序执行：

1. strict TypeScript typecheck；
2. 源码策略检查；
3. 34 项自动测试；
4. 构建；
5. CLI 最小工作流；
6. 插件单文件入口加载 smoke；
7. 独立发布版 CLI 的 version / submit / approve smoke。

源码策略检查会拒绝：

- `@ts-ignore` / `@ts-nocheck`；
- 显式 `any`；
- skipped/focused tests；
- core 对 `obsidian` 的依赖；
- 关闭 strict 或启用 `skipLibCheck`。

## 本地源码运行 CLI

```bash
npm run build
node packages/cli/bin/obsreview.cjs --version
```

或者：

```bash
npm link
obsreview --version
```

## 生成完整交付包

```bash
npm run package
```

该命令会重新执行完整门禁，生成插件、便携 CLI、源码三个 ZIP，从 ZIP 解压后再次验证插件加载与 CLI `submit → approve` 工作流，并生成 SHA-256 校验文件及合集包。

---

# 已知限制

1. 文件系统不能提供数据库式的真正跨文件原子事务。本实现使用全量 preflight、staging、journal、逐项验证和 best-effort rollback；极端磁盘/系统故障仍可能留下需要人工恢复的 transaction，CLI 会停止并报告。
2. 自动 rebase 只处理不重叠的行级编辑；重叠修改必须由人或外部 Agent 重新生成 proposal。
3. Delete 使用项目自己的可恢复 trash，而不是调用 OS Trash；这是为了让 CLI 在 Obsidian 未运行时仍保持一致语义。
4. 大于约 1 MB 的 base+proposal 在 CodeMirror 编辑 modal 中会关闭 decorations，避免长时间阻塞；主 Review diff 仍按 core 的安全限制计算。
5. 当前测试环境没有真实 Obsidian Desktop GUI，因此完成了插件入口加载 smoke，而不是自动点击式 Obsidian E2E。发布包需要在目标 Vault 做一次人工安装验收。
6. `Coder Engram` 这一名称在公开来源中无法被唯一定位；研究文档明确记录为“未确认项目”，没有复制其代码，也没有把不确定信息伪装成事实。

---

# License

本项目使用 MIT License。实际适配的第三方算法及其许可证见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
