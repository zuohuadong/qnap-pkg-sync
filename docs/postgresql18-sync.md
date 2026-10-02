# PostgreSQL 18 同步

`Sync PostgreSQL 18` 工作流从仓库现有 Secrets 配置的、已认证的 QNAP 购买源读取 PostgreSQL 18，下载并上传到现有 CTFile 根目录。不会硬编码购买链接、账号、签名或软件版本。

## 运行方式

- 每日 00:15 UTC 定时运行（北京时间 08:15，日本时间 09:15；实际启动可能受 GitHub Actions 调度影响）。
- 在 Actions → Sync PostgreSQL 18 → Run workflow 手动运行。
- 修改定向同步脚本、对应测试或工作流后，推送到 `main` 自动运行。
- 本地已配置环境变量或 `.env` 后运行：`bun run scripts/postgresql18.mjs`。

所需 Secrets 沿用现有配置：`QNAP_DOWNLOAD_URL`、`QNAP_USERNAME`、`QNAP_PASSWORD`、`CTFILE_SESSION`、`CTFILE_FOLDER_ID`。

## 同步范围与目录

仅选择购买源中名称或 internalName 对应 PostgreSQL 18 / PostgreSQL18 / postgres18 的应用，保留源提供的全部架构。同一个二进制文件可能对应多个 QNAP 机型，按下载文件去重，不重复上传。

目录沿用一般同步器的命名规则：`CTFILE_FOLDER_ID / 产品名称 / YYYY-MM / 安装包.qpkg`。实际产品名称、版本及文件名以购买源为准。

定向工作流在下载前扫描产品目录及月份子目录。远端已有同名文件时直接返回已有文件的链接；缺失时下载并上传，再重新列出 CTFile 文件确认实际存在。该去重判断基于文件名，不能单独证明同名文件内容的完整性，也不负责覆盖上游同版本、同文件名的重新发布内容。

## 结果与失败处理

成功运行会在工作流 Summary 中显示链接，并生成 `postgresql18-ctfile-links` artifact，保留 7 天：

- `links.json`：版本、架构、文件名、CTFile ID、验证时间和链接。
- `links.md`：可读下载清单。

`linkType=file` 表示 CTFile 返回了文件链接；`linkType=folder` 表示仅提供该文件所在目录的链接，不应当作单文件直链。

购买源中缺少授权应用、目录查询失败、文件下载失败或上传后无法确认文件存在时，工作流以失败状态退出，不将失败解释为同步完成。已确认的部分结果会尽可能保存，后续运行按远端现状继续处理。

## 隐私与测试

下载源 XML、带签名的下载地址、安装包和账号配置不会作为 artifact 发布。报告仅包含所选 PostgreSQL 18 文件的分享信息。上传目标沿用现有公开 CTFile 目录，分享信息会出现在该公开仓库的 Actions 日志和 Summary 中。

测试命令：`node --test tests/postgresql18.test.mjs`。测试覆盖选择规则、单条 XML、机型别名、文件名冲突、安全 URL、远端文件确认及报告字段过滤。
