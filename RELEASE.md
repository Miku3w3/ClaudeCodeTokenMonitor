# 发布流程(手动)

> 本仓库**不使用 GitHub Actions 发版**。所有发布动作都在本机手动完成。
> `.vsix`、`node_modules`、`out/` 都被 `.gitignore` 排除,**不进仓库** —— 换电脑后必须按下面步骤重新生成。

发布 = 三件事:**打包装机验证 → 推代码打 tag → 网页建 Release + 上架商城**。

---

## 0. 发布前检查

```bash
cd "d:/Jobs/claude-code/vscode-claude-token-monitor"

npm test                     # 编译 + 全部单元测试,必须 0 失败
node -e "console.log(require('./package.json').version)"
```

确认两件事:

1. `package.json` 的 `version` 是这次要发的版本号
2. `changelog.md` 里有对应的 `## [x.y.z] - YYYY-MM-DD` 一节(Release 正文从这里抄)

> 版本号规则:破坏性改动 X.0.0 / 新功能 x.Y.0 / 只修 bug x.x.Z。
> **大小写注意**:仓库里文件名是 `CHANGELOG.md`、`README.md`(大写),脚本和文档里写小写 —— Windows 不分大小写所以本地没事,但别在 Linux 上跑 `scripts/release-notes.js`。

---

## 1. 打包

```bash
npx vsce package
mv -f claude-code-token-monitor-<version>.vsix archive/
```

产物在 `archive/claude-code-token-monitor-<version>.vsix`。

检查包内容(应该只有 `package.json`、`out/`、`pricing.json`、`icon.png`、README/CHANGELOG/LICENSE 等运行必需文件):

```bash
./node_modules/.bin/vsce ls --tree
```

**不应该出现**:`src/`、`test/`、`docs/`、`.github/`、`scripts/`、`pricing-overrides.json`、`*.vsix`。
`docs/**`、`test/**`、`scripts/**` 已经在 `.vscodeignore` 里排除。

---

## 2. 装进本机验证

```bash
"C:/Program Files/Miku3w3/VSCode-win32-x64-1.138.0/bin/code.cmd" \
  --install-extension "d:/Jobs/claude-code/vscode-claude-token-monitor/archive/claude-code-token-monitor-<version>.vsix" --force
```

> VSCode 路径带版本号,升级后会变 —— 先 `ls "C:/Program Files/Miku3w3/"` 确认。

然后 `Ctrl+Shift+P` → `Developer: Reload Window`,按发布的检查清单手测(清单在仓库外的 `cctm-ops/release-todo.md`)。

**装不上/装上了但功能没变**时,先确认版本号一致:同名版本重装会缓存旧包,必要时先卸载再装。

---

## 3. 提交并推送代码

```bash
git add -A
git commit -m "release: v<version>"
git push origin master
```

> 校园网直连 GitHub 不通,推之前先确认代理开着:`git config --get http.proxy` 应输出 `http://127.0.0.1:7890`。
> 代理没开时会报 `Failed to connect to github.com port 443`。

---

## 4. 打 tag 并推送

```bash
git tag -a v<version> -m "v<version>"
git push origin v<version>
```

tag 必须带 `v` 前缀,且与 `package.json` 版本完全一致。**tag 只是版本标记,不会再自动触发任何构建**。

---

## 5. 在网页上创建 GitHub Release

1. 打开 <https://github.com/Miku3w3/ClaudeCodeTokenMonitor/releases/new>
2. **Choose a tag** → 选刚推的 `v<version>`
3. **Release title** → 用英文卖点格式:
   ```
   v1.3.0 — Accurate Costs · Subagent Tracking · Offline Pricing
   ```
4. **Describe this release** → 粘贴 `docs/release-notes-v<version>.md` 的内容(英文在前,`---` + `# 中文版` 隔开)
5. **Attach binaries** → 上传 `archive/claude-code-token-monitor-<version>.vsix`
6. 不要勾 "Set as a pre-release"
7. **Publish release**

---

## 6. 上架 VS Code Marketplace

需要 Azure DevOps 的 Personal Access Token(PAT),只需要 **Marketplace → Manage** 权限。

```bash
export VSCE_PAT=<你的PAT>
npx vsce publish --packagePath archive/claude-code-token-monitor-<version>.vsix
```

- 版本号已存在会报错;确实要覆盖加 `--skip-duplicate`(它只是跳过重复,不会覆盖)
- 发布后 5–15 分钟页面才刷新,属正常
- 想撤回:`npx vsce unpublish miku3w3.claude-code-token-monitor`,整个扩展会被下架,慎用

> 也可以用浏览器在 <https://marketplace.visualstudio.com/manage/publishers/miku3w3> 手动上传 vsix。

---

## 7. 发布后核对

- [ ] <https://github.com/Miku3w3/ClaudeCodeTokenMonitor/releases> 里新版本在、vsix 能下载
- [ ] <https://marketplace.visualstudio.com/items?itemName=Miku3w3.claude-code-token-monitor> 版本号已更新
- [ ] Marketplace 页面上的 README 渲染正常(图片不挂、表格不错位)
- [ ] 本机已装同版本 vsix 并手测过

---

## 常用命令速查

| 命令 | 作用 |
|---|---|
| `npm run compile` | TypeScript 编译 + 拷贝 i18n 语言文件 |
| `npm test` | 编译并运行单元测试 |
| `npx vsce package` | 打包成 .vsix |
| `./node_modules/.bin/vsce ls --tree` | 查看打包内容 |
| `node scripts/update-pricing.js --validate` | 离线校验 `pricing.json` |
| `node scripts/update-pricing.js --dry-run` | 试跑每日定价更新(需要 AI key) |
| `node scripts/release-notes.js <version>` | 打印 changelog 里某一版的正文 |

## 每日定价更新(服务器 → 阿里云 OSS)

**和发版无关**,由维护者服务器的 cron 每天 03:17 生成并上传,扩展从 OSS 读取。

- 抓取失败保留旧价,单项变动超过 5 倍视为解析错误被拒绝
- `pricing-overrides.json`(人工复核价)优先级最高
- 上传必须带 `--acl public-read`,否则对象变私有、线上 403