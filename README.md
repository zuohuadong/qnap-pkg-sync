# QNAP Apps Sync Tool

QNAP 软件包同步工具，用于获取软件列表、批量下载和上传分享。

## ⚠️ 隐私说明（开源项目）

本项目设计为开源使用，所有敏感配置都**不会提交到 Git 仓库**：

- ✅ `config/` 目录已加入 `.gitignore`
- ✅ CI 使用 **GitHub Actions Artifacts** 管理配置
- ✅ 配置文件在 Artifacts 中保留 90 天
- ✅ 可以安全地 fork 和分享项目


## 功能特性

### 1. 获取软件列表 + 智能差异检测
- 从 `.env` 文件读取 QNAP 下载 URL
- 使用 Basic Authentication（用户名和密码）获取 XML 数据
- 将 XML 转换为 JSON 格式
- 保存到 `config/apps.json`
- ✨ **智能差异检测**：自动对比新旧版本，识别新增/更新的软件
- ✨ **增量更新追踪**：将差异保存到 `config/update-apps.json`

### 2. 批量下载软件
- ✅ 流式下载，支持大文件
- ✅ 实时进度显示（进度条、速度、ETA）
- ✅ Signature 验证
- ✅ 自动重试机制
- ✅ 断点续传支持
- ✅ 按照规范命名文件
- ✅ 支持下载所有软件或指定软件
- ✅ 自动生成元数据文件 (metadata.json)
- ✨ **增量下载**：只下载新增或更新的软件包，节省时间和带宽
- ✨ **自动清理**：下载完成后自动从增量列表中移除

### 3. 上传到 CTFile 并生成分享链接
- ✅ 按软件简称创建文件夹（如 Apache83、OpenList）
- ✅ 在软件文件夹下按月分类（YYYY-MM 格式子文件夹）
- ✅ 上传到对应的软件/月份文件夹
- ✅ 生成包含所有文件信息的 README
- ✅ 输出：文件名、架构、版本、更新日期、下载地址
- ✅ 保存上传后的元数据

## 环境要求

- [Bun](https://bun.sh/) >= 1.0

## 配置

### 环境变量配置

在 `.env` 文件中配置以下变量（参考 `.env.example`）：

```bash
# QNAP 认证信息
QNAP_USERNAME=your_username
QNAP_PASSWORD=your_password
QNAP_DOWNLOAD_URL=https://update.qnap.com/FirmwareRelease.xml

# CTFile 配置（可选，用于上传）
CTFILE_SESSION=your_session_token
CTFILE_FOLDER_ID=your_folder_id
CTFILE_USER=your_ctfile_username
CTFILE_PASSWORD=your_ctfile_password

# WebDAV 配置（可选，作为备用上传方案）
WEBDAV_URL=https://your-webdav-server.com
WEBDAV_USERNAME=your_webdav_username
WEBDAV_PASSWORD=your_webdav_password
WEBDAV_ROOT_PATH=/qnaporg
```

### 配置文件结构

项目使用以下目录结构管理配置：

```
├── config/                      # 本地配置目录（不提交到 Git）
│   ├── apps.json               # 软件包列表（含敏感 signature，自动生成）
│   └── update-apps.json        # 增量更新列表（临时文件）
├── config.example/              # 配置示例（提交到 Git）
│   ├── apps.example.json       # apps.json 格式示例
│   └── README.md               # 配置文件说明
└── .env                         # 环境变量（不提交到 Git）
```

**重要提示**：
- ✅ `config.example/` 是示例配置，可以安全提交
- ❌ `config/` 包含敏感信息（下载签名等），已加入 `.gitignore`
- ❌ `.env` 包含账号密码，已加入 `.gitignore`
- 📦 CI/CD 使用 **GitHub Actions Artifacts** 管理配置文件（保留 90 天）

## 安装

```bash
bun install
```

## 使用方法

### 步骤 1: 获取软件列表

```bash
bun run fetch
```

这将：
1. 从 `.env` 读取配置
2. 使用用户名和密码访问 `QNAP_DOWNLOAD_URL`
3. 下载 XML 内容
4. 转换为 JSON
5. 保存到 `config/apps.json`
6. **智能对比**：与之前的版本比较，找出差异
7. **生成增量列表**：如果有更新，保存到 `config/update-apps.json`

**输出示例**：
```
📋 检测到 5 个新增或更新的软件包

📝 新或更新的应用：
   • Apache83: 2465.83260 → 2465.83270 (updated)
   • MySQL80: 3407.80640 → 3407.80650 (updated)
   • OpenList v4.1.7 (new)
```

### 步骤 2: 下载软件包

#### 🚀 增量下载（推荐）

只下载新增或更新的软件包，大幅节省时间和带宽：

```bash
bun run download:update
```

这将：
1. 读取 `config/update-apps.json` 中的更新列表
2. 只下载有变化的软件包
3. 下载成功后自动从更新列表中移除
4. 合并到现有的 `metadata.json`
5. 所有更新下载完成后，自动删除 `update-apps.json`

**特点**：
- ⚡ **快速**：只下载需要的文件
- 💾 **节省带宽**：跳过已有的软件包
- 🔄 **可恢复**：下载中断后重新运行会继续未完成的下载
- 🧹 **自动清理**：完成后自动清理临时文件

#### 下载所有软件包

```bash
bun run download
# 或
bun run download:all
```

#### 下载指定软件

```bash
bun run download "Apache83"
bun run download "MUSL Framework"
bun run download "OpenList"
```

下载的文件会保存到 `downloads/` 目录，文件名按照 URL 中的原始名称：
- `Apache83_2465.83260_x86_64.qpkg`
- `MUSL_CROSS_11.1.5_arm_64.qpkg`
- `OpenList_4.1.6_x86_64.qpkg`

下载完成后会自动生成 `config/metadata.json`，包含所有下载文件的元数据。

### 步骤 3: 上传到 CTFile 并生成分享链接

```bash
bun run upload
```

此命令会：
1. 读取 `config/metadata.json` 文件
2. 按软件简称分组（如 Apache83、MUSL_Framework、OpenList）
3. 为每个软件创建文件夹，并在其下创建当月子文件夹（如 `Apache83/2025-11/`）
4. 上传所有文件到对应的软件/月份文件夹
5. 保存 `config/metadata-uploaded.json` 包含上传后的完整信息

### CTFile 文件夹结构

上传后，CTFile 中的文件夹结构如下：

```
CTFILE_FOLDER_ID (根文件夹)
├── Apache83/
│   └── 2025-11/
│       ├── Apache83_2465.83260_x86_64.qpkg
│       ├── Apache83_2465.83260_arm_64.qpkg
│       └── Apache83_2465.83260_arm-x41.qpkg
├── Apache84/
│   └── 2025-11/
│       ├── Apache84_2465.84140_x86_64.qpkg
│       ├── Apache84_2465.84140_arm_64.qpkg
│       └── Apache84_2465.84140_arm-x41.qpkg
├── MUSL_Framework/
│   └── 2025-11/
│       ├── MUSL_CROSS_11.1.5_x86_64.qpkg
│       ├── MUSL_CROSS_11.1.5_arm_64.qpkg
│       └── ...
└── OpenList/
    └── 2025-11/
        ├── OpenList_4.1.6_x86_64.qpkg
        ├── OpenList_4.1.6_arm_64.qpkg
        └── OpenList_4.1.6_arm-x41.qpkg
```

### 生成的 README 示例

生成的 `PACKAGES.md` 包含：

```markdown
# QNAP Software Packages - Download Links

Generated on: 2025-11-08 12:00:00

Total Products: 4
Total Files: 50

## Apache83

**Version:** 2465.83260
**Update Time:** 2023-11-10 14:52:24

### Available Architectures

| Architecture | Filename | File Size | Download Link |
|--------------|----------|-----------|---------------|
| TS-NASX86 | Apache83_2465.83260_x86_64.qpkg | 150.25 MB | [🔗 Download](https://...) |
| TS-NASARM_64 | Apache83_2465.83260_arm_64.qpkg | 145.30 MB | [🔗 Download](https://...) |

---
```

```
============================================================
QNAP XML Fetcher
============================================================

📋 Configuration:
   URL: https://www.qnap.xxx/xml/xxx.xml
   Username: your_username
   Output: config/packages.json

📥 Fetching XML from: https://www.qnap.xxx/xml/xxx.xml
📄 Content-Type: application/xml; charset=utf-8
✓ Fetched 38.7 KB of XML data
🔄 Converting XML to JSON...
✓ XML converted to JSON successfully
💾 Saving JSON to: config/packages.json
✓ Saved 39.0 KB to config/packages.json

============================================================
✅ Successfully completed!
============================================================
```

## 下载进度示例

```
[████████████████░░░░░░░░░░░░░░] 54.2% | 125.43 MB/231.50 MB | 2.34 MB/s | ETA: 45s
```

实时显示：
- 进度条
- 下载百分比
- 已下载/总大小
- 当前速度
- 预计剩余时间

## Signature 验证

下载完成后会自动验证文件的 signature（MD5 校验）：
- ✓ 验证通过：显示绿色勾号
- ⚠ 跳过验证：signature 格式可能不是标准 MD5

## 项目结构

```
.
├── .env                    # 环境变量配置
├── .github/
│   └── workflows/
│       └── sync-packages.yml  # GitHub Actions CI 配置（支持增量更新）
├── config/
│   ├── apps.json          # 软件列表 JSON（含敏感签名，不提交到 Git）
│   └── update-apps.json   # 增量更新列表（临时文件，不提交）
├── downloads/              # 下载的软件包
│   ├── metadata.json      # 下载元数据
│   ├── metadata-uploaded.json  # 上传元数据
│   └── PACKAGES.md        # 软件包清单
├── src/
│   ├── env.ts             # 环境变量工具函数
│   ├── fetch-xml.ts       # 获取软件列表 + 差异检测
│   ├── download.ts        # 下载主程序
│   ├── download-apps.ts   # 下载逻辑实现（含增量下载）
│   ├── download-updates.ts # 增量下载入口
│   ├── upload.ts          # 上传到 CTFile
│   └── ctfile.ts          # CTFile API 客户端
├── package.json
└── README.md
```

## 技术栈

- **Runtime**: Bun
- **Language**: TypeScript
- **Dependencies**:
  - `xml2js`: XML 转 JSON 解析器

## 技术亮点

### 智能增量更新

通过对比新旧 `apps.json`，自动识别变化：

```typescript
// 检测新增软件
if (!oldApp) {
  differences.push(newApp);
}
// 检测版本更新
else if (oldApp.version !== newApp.version) {
  differences.push(newApp);
}
// 检测平台变化
else if (hasNewPlatforms(oldApp, newApp)) {
  differences.push(newApp);
}
```

只下载有变化的软件包，大幅提升效率。

### 流式下载

使用 Bun 的流式 API 进行下载，避免将整个文件加载到内存：

```typescript
const reader = response.body.getReader();
const writer = file.writer();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  writer.write(value);  // 边下载边写入磁盘
}
```

### 自动重试

下载失败时自动重试最多 3 次，每次重试间隔递增，提高下载成功率。

### 断点续传

支持 HTTP Range 请求，下载中断后可从断点继续下载（如果服务器支持）。

## GitHub Actions CI/CD

项目包含完整的 CI/CD 配置，支持：

- ⏰ **定时任务**：每周一自动检查更新
- 🔍 **智能检测**：自动对比差异，只下载更新
- ⚡ **增量下载**：节省时间和带宽
- 📤 **自动上传**：上传到 CTFile 并生成分享链接
- 📝 **自动提交**：将更新提交回仓库
- 🎯 **手动触发**：支持强制全量下载、仅下载、仅上传等选项

### 使用方式

#### 1. **配置 GitHub Secrets**

在 GitHub 仓库设置中添加以下 Secrets：

**必需的 Secrets**：
- `QNAP_USERNAME` - QNAP 下载源用户名（如果需要）
- `QNAP_PASSWORD` - QNAP 下载源密码（如果需要）

**上传相关 Secrets**（可选）：
- `CTFILE_SESSION` - CTFile 会话 token
- `CTFILE_FOLDER_ID` - CTFile 根文件夹 ID
- `CTFILE_USER` - CTFile 用户名
- `CTFILE_PASSWORD` - CTFile 密码

**备用上传方案 Secrets**（可选）：
- `WEBDAV_URL` - WebDAV 服务器地址
- `WEBDAV_USERNAME` - WebDAV 用户名
- `WEBDAV_PASSWORD` - WebDAV 密码

#### 2. **运行方式**

**自动运行**：
- 每周一 UTC 0:00（北京时间 8:00）自动运行
- 自动检测更新、增量下载、上传

**手动触发**：
   - 进入 Actions 页面
   - 选择 "Sync QNAP Packages" 工作流
   - 点击 "Run workflow"
   - 可选参数：
     - `force_download`: 强制下载所有软件包
     - `download_only`: 仅下载，不上传
     - `upload_only`: 仅上传已有文件

### CI 工作流程

```
检出代码 → 设置 Bun → 安装依赖
    ↓
从 Artifacts 恢复上次的 apps.json
    ↓
获取软件列表（fetch）→ 检测差异
    ↓
有更新？
    ├─ 是 → 增量下载 → 上传到 CTFile → 保存 apps.json 到 Artifacts → 提交元数据
    └─ 否 → 跳过下载 → 结束
```

**配置管理说明**：
- 📦 `apps.json` 保存在 **GitHub Actions Artifacts** 中（90 天保留期）
- 🔒 **不会提交到 Git 仓库**，保护隐私（包含敏感的下载签名）
- 🔄 每次运行自动恢复和更新
- ✅ 支持增量检测和下载
- 🛡️ ���个 `config/` 目录已加入 `.gitignore`

### Fork 项目使用指南

如果你 fork 了本项目：

1. **配置 Secrets**：按照上述说明在你的仓库中添加必要的 Secrets
2. **首次运行**：手动触发工作流，系统会自动生成 `apps.json`
3. **后续运行**：CI 会自动从 Artifacts 恢复配置，实现增量更新
4. **本地开发**：运行 `bun run fetch` 生成本地配置文件

## 许可证

MIT
