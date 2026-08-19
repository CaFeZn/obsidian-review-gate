# 测试与验证

## 执行命令

```text
npm run check
```

`check` 包含：

```text
strict TypeScript typecheck
source policy check
node:test integration suite
plugin release + standalone CLI build
submit/approve smoke workflow
plugin entry load smoke
release CLI smoke
```

## 自动测试矩阵

### Core

- SHA-256 deterministic/compatibility；
- Review/Change ID；
- state transition；
- traversal/absolute/drive/storage path rejection；
- symlink escape；
- line hunk + inline fragment；
- hunk accept/reject proposal semantics；
- create hunk rollback to empty；
- conservative rebase clean/conflict；
- vendored Myers deterministic fuzz reconstruction。

### CLI

- submit/status/update/cancel；
- one-line JSON；
- stable exit codes；
- invalid target；
- manifest multi-file submit；
- watcher-driven wait；
- timeout/Ctrl+C behavior paths。

### Service / Storage / Transaction

- submit snapshots base without target mutation；
- external proposal reconciliation；
- concurrent revision conflict；
- approve-time base conflict；
- multi-file all-or-none preflight；
- modify/create/delete apply + history；
- rename；
- hunk decisions do not touch target；
- rebase；
- explicit force apply + backup；
- reject/cancel history without target write；
- corrupted metadata；
- crash-like temp files；
- applying/committed transaction recovery。

### Watcher

- atomic external proposal save；
- metadata revision reconciliation；
- target advisory conflict marker；
- authoritative approve check remains independent。

## 本交付环境结果

最终打包时由 `npm run check` 重新生成。本文件中的最终结果应与控制台和 `docs/progress.md` 一致。

- TypeScript：strict，no suppression，no explicit `any`；
- 自动测试：34/34 通过；
- 最小 submit → pending target unchanged → approve applied：通过；
- 发布版插件入口 load smoke：通过；
- 独立 release CLI version/workflow smoke：通过；
- 真实 Obsidian GUI 人工视觉回归：本执行环境无法启动，因此未声称已完成。
