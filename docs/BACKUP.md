# Config Backup - 加密备份说明

## 概述

这个 workflow 会将 `config/` 目录下的所有文件打包、加密后上传到 GitHub Actions Artifacts，确保配置文件的安全存储。

## 安全特性

✅ **AES-256-CBC 加密** - 军事级加密标准
✅ **私有 Artifacts** - 只有仓库维护者可访问
✅ **可配置保留期** - 默认 90 天
✅ **密码保护** - 需要密码才能解密

---

## 快速开始

### 1. 设置加密密码

在 GitHub 仓库中添加 Secret：

1. 进入仓库 → Settings → Secrets and variables → Actions
2. 点击 **New repository secret**
3. Name: `BACKUP_ENCRYPTION_PASSWORD`
4. Value: 你的强密码（建议使用密码生成器）
5. 点击 **Add secret**

### 2. 运行备份

**手动触发：**
1. 进入 Actions 标签页
2. 选择 "Backup Config Files (Encrypted)" workflow
3. 点击 "Run workflow"
4. 等待完成

**自动备份（可选）：**

编辑 `.github/workflows/backup-config.yml`，取消注释定时任务：

```yaml
on:
  workflow_dispatch:
  schedule:
    - cron: '0 0 * * 0'  # 每周日 00:00 UTC
```

### 3. 下载和解密

**方法 1: 使用提供的脚本（推荐）**

```bash
# 1. 下载加密的备份
gh run download <run-id> -n config-backup-encrypted-<run-id>

# 2. 设置密码
export BACKUP_ENCRYPTION_PASSWORD="your-password"

# 3. 运行解密脚本
./scripts/decrypt-backup.sh config-backup.tar.gz.enc
```

**方法 2: 手动解密**

```bash
# 1. 下载
gh run download <run-id> -n config-backup-encrypted-<run-id>

# 2. 解密
export BACKUP_ENCRYPTION_PASSWORD="your-password"
openssl enc -aes-256-cbc -d -pbkdf2 \
  -in config-backup.tar.gz.enc \
  -out config-backup.tar.gz \
  -pass env:BACKUP_ENCRYPTION_PASSWORD

# 3. 解压
tar -xzf config-backup.tar.gz
```

---

## 在其他 Workflow 中使用

可以在主 workflow 中调用备份：

```yaml
jobs:
  sync-packages:
    runs-on: ubuntu-latest
    steps:
      # ... 你的同步步骤 ...

  backup-configs:
    needs: sync-packages
    uses: ./.github/workflows/backup-config.yml
    secrets: inherit
    with:
      retention-days: 90
```

---

## 文件说明

| 文件 | 说明 |
|------|------|
| `.github/workflows/backup-config.yml` | 加密备份 workflow |
| `scripts/decrypt-backup.sh` | 解密脚本（本地使用） |
| `config-backup.tar.gz.enc` | 加密后的备份文件 |

---

## 常见问题

**Q: 加密安全吗？**
A: 使用 AES-256-CBC 加密，配合强密码非常安全。确保密码足够复杂（建议 20+ 字符）。

**Q: 忘记密码怎么办？**
A: 无法解密。请妥善保管密码（建议使用密码管理器）。

**Q: Artifacts 保留多久？**
A: 默认 90 天，可以在运行时自定义（最长 90 天）。

**Q: 可以不加密吗？**
A: 可以，但不推荐。如果不设置 `BACKUP_ENCRYPTION_PASSWORD` secret，会上传未加密的文件。

---

## 安全建议

1. ⚠️ **使用强密码** - 至少 20 字符，包含大小写字母、数字、符号
2. ⚠️ **不要分享密码** - 只在 GitHub Secrets 中存储
3. ⚠️ **定期备份** - 建议每周自动备份
4. ⚠️ **验证备份** - 定期测试解密过程
5. ⚠️ **保留本地副本** - 不要只依赖 Artifacts（90天后会删除）
