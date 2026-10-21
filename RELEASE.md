# 发布流程 (Release Process)

> 目的:让"打包 / 上架"可复现,不再靠手工打 .vsix。
> `.vsix`、`node_modules`、`out/` 都被 `.gitignore` 排除,**不进仓库**——换电脑后必须按下面的步骤重新生成。

## 一次发布的标准步骤

1. 确认 `master` 已推送:`git push origin master`
2. 改 `package.json` 的 `version`,并在 `changelog.md` 按 **Keep a Changelog** 格式新增一节:

   ```markdown
   ## [x.y.z] - 2026-10-21
   ### Fixed
   - ...
   ```

   标题必须能匹配 `## [x.y.z]`,否则 release workflow 会拒绝发版(它用 `scripts/release-notes.js` 抽取这一节作为 Release 正文)。
3. `npm test`(编译 + 22 个单元测试)全部通过。
4. 提交并推送:`git commit -m "chore: bump to x.y.z"` → `git push origin master`
5. 打标签(**必须带 `v` 前缀,且与 package.json 版本完全一致**):

   ```bash
   git tag -a v1.3.0 -m "v1.3.0"
   git push origin v1.3.0
   ```

6. GitHub Actions(`.github/workflows/release.yml`)收到 `v*` 标签后自动:
   - 校验 tag 与 `package.json` 版本一致
   - 跑测试
   - 打包 `release/claude-code-token-monitor-x.y.z.vsix`
   - 从 changelog 抽取该版本正文,创建 GitHub Release 并挂上 .vsix
7. 检查:https://github.com/Miku3w3/ClaudeCodeUsage/releases

## 本地打包验证(不打标签时用)

```bash
npm install
npm test          # 编译 + 测试
npx vsce package  # 生成 claude-code-token-monitor-x.y.z.vsix
./node_modules/.bin/vsce ls --tree   # 确认打包内容
```

## 上架到 Visual Studio Marketplace

- 手动:`VSCE_PAT=<PAT> npx vsce publish --packagePath <vsix>`
- 自动(推荐):在仓库 **Settings → Secrets and variables → Actions** 添加 **`MARKETPLACE_PUBLISHER_TOKEN`**(Azure DevOps PAT,只勾 Marketplace 范围)。
  存在该 secret 时 workflow 会自动 `vsce publish --skip-duplicate`;没有则只在 GitHub 发 Release,并输出一条 notice。

## 每日定价更新(服务器 → 阿里云 OSS)

定价由维护者服务器的 cron 每天 03:17 生成,上传到 `cctm-pricing` Bucket,扩展从 OSS 读取。
仓库里**没有**定价 workflow(GitHub Actions 版已于 2026-10-21 删除,避免与服务器双跑)。
完整部署手册见 `docs/pricing-hosting.md`。

要点:

1. 抓取失败保留旧价,单项变动超过 5 倍视为解析错误被拒绝
2. `pricing-overrides.json`(人工复核价)优先级最高
3. 上传必须带 `--acl public-read`,否则对象变私有、线上 403

## 常用命令速查

| 命令 | 作用 |
|---|---|
| `npm run compile` | TypeScript 编译 + 拷贝 i18n 语言文件 |
| `npm test` | 编译并运行单元测试 |
| `npm run package` | 打包成 .vsix(内部会自动先编译) |
| `node scripts/update-pricing.js --validate` | 离线校验 `pricing.json` |
| `node scripts/update-pricing.js --dry-run` | 试跑每日定价更新(需要 AI key) |
| `node scripts/release-notes.js x.y.z` | 打印某个版本的 changelog 正文 |