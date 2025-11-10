# QNAP Apps Sync Tool

QNAP 软件包同步工具，用于获取软件列表、批量下载和上传分享。

## ⚠️ 隐私说明（开源项目）

本项目设计为开源使用，所有敏感配置都**不会提交到 Git 仓库**：

- ✅ `config/` 目录已加入 `.gitignore`
- ✅ CI 使用 **GitHub Actions Cache** 管理配置
- ✅ Cache 每次访问自动续期 7 天（定时任务每日运行，实际上持久保存）
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
- 📦 CI/CD 使用 **GitHub Actions Cache** 管理配置文件（自动续期）

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

### 步骤 2: 检查 CTFile 已存在文件（可选）

在下载前，可以检查 CTFile 中已经存在的文件，避免重复上传：

```bash
bun run check-existing
```

这将：
1. 遍历 CTFile 指定文件夹下的所有子文件夹
2. 提取已上传的文件信息（文件名、版本号）
3. 与本地 `config/apps.json` 对比
4. 生成智能的增量下载列表，只下载未上传的文件

### 步骤 3: 下载软件包

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

### 步骤 4: 检查上传状态（可选）

在上传前，可以检查哪些文件已经上传过，避免重复上传：

```bash
bun run check-upload
```

这将：
1. 读取 `config/upload-progress.json`（上传进度缓存）
2. 对比 `config/metadata.json` 中的文件
3. 生成需要上传的文件列表
4. 显示已上传和待上传的文件统计

### 步骤 5: 上传到 CTFile 并生成分享链接

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
│       └── sync-packages.yml  # GitHub Actions CI 配置
├── config/
│   ├── apps.json          # 软件列表 JSON（含敏感签名，不提交到 Git）
│   ├── update-apps.json   # 增量更新列表（临时文件）
│   ├── metadata.json      # 下载元数据
│   └── upload-progress.json  # 上传进度缓存
├── downloads/              # 下载的软件包
│   ├── metadata-uploaded.json  # 上传元数据
│   └── PACKAGES.md        # 软件包清单
├── src/
│   ├── env.ts             # 环境变量工具函数
│   ├── fetch-xml.ts       # 获取软件列表 + 差异检测
│   ├── download.ts        # 下载主程序（下载所有）
│   ├── download-apps.ts   # 下载逻辑实现（含增量下载）
│   ├── download-updates.ts # 增量下载入口
│   ├── check-existing-files.ts # 检查 CTFile 已存在文件
│   ├── check-upload.ts    # 检查上传状态和进度
│   ├── upload.ts          # 上传到 CTFile（支持 WebDAV fallback）
│   ├── force-sync.ts      # 强制同步（恢复错误状态）
│   ├── ctfile.ts          # CTFile API 客户端
│   ├── ctfile-utils.ts    # CTFile 工具函数
│   ├── webdav-client.ts   # WebDAV 客户端（备用上传方案）
│   ├── diagnose-ctfile.ts # CTFile 诊断工具
│   └── check-folders.ts   # 检查文件夹结构
├── package.json
└── README.md
```

## 技术栈

- **Runtime**: Bun
- **Language**: TypeScript
- **Dependencies**:
  - `xml2js`: XML 转 JSON 解析器

## 技术亮点

### CTFile 文件存在性检查

通过 CTFile API 遍历云端文件夹，检查已上传的文件：

```typescript
// 获取文件夹内容
const folders = await ctfile.getFolderContents(folderId);

// 提取文件名中的版本信息
const existingVersions = new Set(
  files.map(f => extractVersionFromFilename(f.name))
);

// 智能跳过已存在的版本
if (existingVersions.has(app.version)) {
  console.log(`✓ 跳过: ${app.name} ${app.version} (已存在)`);
}
```

避免重复下载和上传，大幅节省时间。

### 上传进度缓存

使用 `upload-progress.json` 记录上传成功的文件：

```typescript
// 上传成功后记录进度
uploadProgress[filename] = {
  uploadedAt: new Date().toISOString(),
  ctfileUrl: shareUrl,
  folderId: targetFolderId
};

// 下次运行时跳过已上传的文件
if (uploadProgress[filename]) {
  console.log(`✓ 跳过: ${filename} (已上传)`);
}
```

支持断点续传，上传中断后可恢复。

### WebDAV 备用上传

CTFile 上传失败时自动切换到 WebDAV：

```typescript
try {
  // 尝试 CTFile 上传
  await ctfile.uploadFile(file);
} catch (error) {
  // 失败时 fallback 到 WebDAV
  await webdav.uploadFile(file);
}
```

提高上传成功率，确保数据安全。

### BBR TCP 拥塞控制

CI 环境自动启用 BBR 算法：

```bash
sudo sysctl -w net.core.default_qdisc=fq
sudo sysctl -w net.ipv4.tcp_congestion_control=bbr
```

显著提升下载速度，特别是在高延迟网络环境中。

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

- ⏰ **定时任务**：每天自动检查更新（UTC 23:00 / 北京时间 7:00）
- 🔍 **智能检测**：自动对比差异，避免重复下载
- 🚀 **CTFile 文件检查**：检查云端已存在的文件，智能跳过
- ⚡ **增量下载**：只下载需要的文件，节省时间和带宽
- 📤 **断点续传**：支持上传进度缓存，失败后可恢复
- 🌐 **WebDAV 备份**：CTFile 上传失败时自动切换到 WebDAV
- ⚡ **BBR 加速**：启用 BBR TCP 拥塞控制算法，提升下载速度
- 📝 **状态持久化**：使用 GitHub Actions Cache 保存配置和进度

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
- 每天 UTC 23:00（北京时间 7:00）自动运行
- 自动检测更新、增量下载、上传

**手动触发**：
   - 进入 Actions 页面
   - 选择 "Sync QNAP Packages" 工作流
   - 点击 "Run workflow"
   - 可选参数：
     - `decrypt_config`: 解密本地加密的配置文件到 Cache（首次设置时使用）

### CI 工作流程

```
检出代码 → 设置 Bun → 安装依赖 → 启用 BBR 加速
    ↓
从 Cache 恢复配置文件（apps.json, upload-progress.json, metadata.json）
    ↓
步骤1: 获取最新软件列表（fetch）→ 检测差异
    ↓
步骤2: 检查上传状态（check-upload）→ 分析已上传文件
    ↓
步骤3: 检查 CTFile 已存在文件（check-existing）→ 智能跳过
    ↓
步骤4: 下载更新的软件包（update）→ 只下载需要的
    ↓
步骤5: 上传到 CTFile（upload）→ 失败时 fallback 到 WebDAV
    ↓
自动更新 Cache（config/ 目录）→ 下次运行恢复
```

**配置管理说明**：
- 📦 配置文件保存在 **GitHub Actions Cache** 中
- ⏰ Cache 每次访问自动续期 7 天（定时任务每日运行，实际持久保存）
- 🔒 **不会提交到 Git 仓库**，保护隐私（包含敏感的下载签名）
- 🔄 每次运行自动恢复和更新配置
- ✅ 支持断点续传和进度恢复
- 🛡️ 整个 `config/` 目录已加入 `.gitignore`

### Fork 项目使用指南

如果你 fork 了本项目：

1. **配置 Secrets**：按照上述说明在你的仓库中添加必要的 Secrets
2. **首次运行**：手动触发工作流，系统会自动生成 `apps.json` 和 Cache
3. **后续运行**：CI 会自动从 Cache 恢复配置，实现增量更新和断点续传
4. **本地开发**：运行 `bun run fetch` 生成本地配置文件
5. **配置加密**（可选）：可以将本地 `config/` 目录加密为 `config.tar.gz.enc`，通过手动触发工作流中的 `decrypt_config` 选项导入到 Cache

## 可用命令

```bash
# 获取软件列表并检测差异
bun run fetch

# 检查 CTFile 中已存在的文件
bun run check-existing

# 检查上传状态
bun run check-upload

# 下载所有软件包
bun run download

# 下载更新的软件包（增量）
bun run update

# 上传到 CTFile
bun run upload

# 强制同步（用于恢复错误状态）
bun run force-sync
```

## 许可证

MIT
