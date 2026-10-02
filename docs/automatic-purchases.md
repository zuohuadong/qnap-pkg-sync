# 已购软件自动同步

`Sync QNAP Packages` 现在使用 `bun run sync`。它从当前账号的完整购买源发现软件，
核对 CTFile 实际文件，而不是依赖 `update-apps.json`、旧配置差异或本地下载记录。
**以后在同一账号购买的软件，只要出现在所配置的购买源中，就不需要逐个修改代码。**

## 执行与结果

- 每天 UTC 23:17（次日北京时间 07:17、日本时间 08:17）计划执行。不是购买事件实时触发。
- Actions → Sync QNAP Packages → Run workflow：`product` 留空同步全部；可输入精确产品名或 internalName；`dry_run` 只检查。
- 修改核心实现的 main 提交也运行同步；功能分支只进行只读验收，PR 仅运行无凭据测试。
- PostgreSQL 18 已包含在通用同步中，原专用工作流改为手动入口并复用通用实现，不再重复定时运行。
- `reports/purchases/links.md`、`report.json` 在 Actions Summary / `purchased-packages-ctfile-links` artifact 中保存。
  清单区分已验证链接和缺失、失败、未处理项目。产物保留 30 天。
- 失败运行返回非零状态，并维护一个 GitHub 失败 Issue；下一次完整同步成功后关闭。
  GitHub 是否发送邮件/推送取决于账号通知设置。专项或只读任务不会错误关闭全量失败告警。

## 重试与完整性

每次扫描产品目录及历史子目录；目录列表与文件列表使用正确的分页端点。
缓存丢失不会隐藏缺包，目录/API 错误不会被误判为空目录。安装包按文件名去重，
多个 NAS 型号共享同一个二进制时只同步一次；目录名冲突和同名二进制冲突失败隔离。

逐包下载到临时目录，验证实际长度、拒绝 HTML/JSON 错误页；文件流式写盘并计算 MD5。
上传后回读远端名称、文件 ID、字节大小，再检查真实分享接口返回的名称和 ID；
有可用 MD5 时也核对。只有验证完成才记录成功和输出分享链接。
请求超时但文件已落盘可以回读恢复；无法确定的上传结果不会直接二次上传。
单个软件失败不阻止其他软件。缺失或失败项目将在下一次完整核对时重试，不需要 `force_sync`。
运行预算耗尽后剩余项目保持 pending；不删除远端旧版本。

`.sync-state/receipts.json` 只保存已验证收据、大小、MD5 和源签名的 SHA-256 指纹。
同名同版本但签名变化时重新同步，旧版本不删除。**缓存失效时，缺包/新版本仍能被发现，
但无法仅凭文件名识别服务商同名同版本且无可验证内容标识的重新打包。**
QNAP 的 opaque signature 不一定是整个 QPKG 的 MD5；未识别格式不会被宣称为数字签名验证成功。
来源签名只有明确的完整 MD5 格式才强制比对。公开分享元数据验证不等于在真实 NAS 上安装验收。

使用有时限的 cURL 上传，签名 URL 和 WebDAV 认证仅通过 stdin 传递。
只有确认 REST 上传尚未发送数据时，才尝试配置好的 CTFile WebDAV；已发送数据的异常先等待回读确认。
WebDAV 使用 `If-None-Match: *`，不会覆盖既有同名文件。大型软件仍受 runner 磁盘、8 GiB 单包上限、
20 分钟单次传输与 6 小时作业上限约束；超限会明确失败而不是漏标成功。

## 配置和长期运行边界

复用现有 Secrets：`QNAP_DOWNLOAD_URL`、`QNAP_USERNAME`、`QNAP_PASSWORD`、
`CTFILE_SESSION`、`CTFILE_FOLDER_ID`。可选 WebDAV Secrets 继续沿用；路径为 `/qnaporg-github`。
这些凭据、购买 XML、签名下载 URL 都不进入公开报告、仓库文件或配置 artifacts。
旧分步命令保留供手动诊断，但已不参与每日同步；旧配置解密/force_sync 开关不再需要。

GitHub Actions 定时任务可能排队延迟；公开仓库连续 60 天无活动可能自动停用定时工作流。
工作流会记录 GitHub 返回的 activation state；本次修改 cron 可重新激活因 inactivity 停用的任务。
这不等于已观察到未来定时事件，也不能在整个 GitHub 调度停止时自行告警。
长期无人值守需检查 Actions 是否启用、Secrets 是否有效，以及额度/磁盘空间是否充足；
需要平台无活动时也可靠运行，应使用独立调度器触发 workflow_dispatch，并独立监控最近成功时间。

官方说明：https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
