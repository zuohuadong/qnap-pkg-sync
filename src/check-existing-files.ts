#!/usr/bin/env bun

/**
 * Check Existing Files from Upload Progress
 *
 * 从 upload-progress.json 检查 update-apps.json 中的文件是否已上传
 * 避免重复下载已上传的文件
 *
 * 功能：
 * 1. 读取 config/upload-progress.json（已上传的文件记录）
 * 2. 读取 config/update-apps.json（待下载的文件列表）
 * 3. 按软件名称、版本号、架构匹配
 * 4. 删除已上传的软件包（按架构）
 * 5. 保存清理后的 update-apps.json
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { loadEnv } from './env';
import { parseQpkgFilename } from './ctfile-utils';
import { getFilenameFromUrl } from './utils/file';
import type { AppsConfig, AppItem, Platform } from './types/index';

/**
 * Upload progress record structure
 */
interface UploadProgress {
  [filename: string]: {
    signature: string;
    ctfileUrl: string;
    ctfileShortUrl?: string;
    ctfileFolderUrl?: string;
    uploadDate: string;
  };
}

/**
 * Main function
 */
async function main() {
  console.log('='.repeat(60));
  console.log('从上传记录检查待下载文件');
  console.log('='.repeat(60));

  // Load environment
  await loadEnv();

  // Get file paths
  const progressFilePath = join(process.cwd(), 'config', 'upload-progress.json');
  const updateFilePath = join(process.cwd(), 'config', 'update-apps.json');

  // Check if update-apps.json exists
  if (!existsSync(updateFilePath)) {
    console.log(`\n⚠️  未找到 config/update-apps.json`);
    console.log('   没有待下载的文件');
    return;
  }

  console.log(`\n📋 读取文件:`);
  console.log(`  待下载列表: config/update-apps.json`);
  console.log(`  上传记录: config/upload-progress.json`);

  // Load update-apps.json
  const updateFile = Bun.file(updateFilePath);
  const appsData: AppsConfig = await updateFile.json();
  const apps = appsData.plugins.item || [];

  console.log(`\n📦 待下载软件包: ${apps.length} 个`);

  if (apps.length === 0) {
    console.log('\n✓ 没有待下载的软件包');
    return;
  }

  // Load upload-progress.json
  let uploadProgress: UploadProgress = {};
  let uploadedCount = 0;

  if (existsSync(progressFilePath)) {
    const progressFile = Bun.file(progressFilePath);
    uploadProgress = await progressFile.json();
    uploadedCount = Object.keys(uploadProgress).length;
    console.log(`📤 已上传文件记录: ${uploadedCount} 个`);
  } else {
    console.log(`📤 已上传文件记录: 0 个（未找到 upload-progress.json）`);
  }

  // Build index of uploaded files: productName-version-arch -> filename
  // Only use exact version matching to avoid false positives when new versions are released
  const uploadedIndex = new Map<string, string>();

  for (const [filename, record] of Object.entries(uploadProgress)) {
    const parsed = parseQpkgFilename(filename);
    if (parsed.version && parsed.arch) {
      // Extract product name from filename (before version)
      const productName = filename.replace(/_[\d.]+_[^.]+\.qpkg$/, '');

      // Key with version from filename (exact match only)
      const keyWithVersion = `${productName}-${parsed.version}-${parsed.arch}`;
      uploadedIndex.set(keyWithVersion, filename);
    }
  }

  console.log(`\n🔍 开始检查文件...\n`);

  let totalPlatforms = 0;
  let totalExisting = 0;
  let totalMissing = 0;

  // Process each app and its platforms
  const updatedApps: AppItem[] = [];

  for (const app of apps) {
    const productName = app.name;
    const version = app.version;

    // Extract product name prefix (for matching with uploaded files)
    // Example: "AdGuard Home (Premium)" -> "ADGuard"
    const productPrefix = app.internalName || productName.split(' ')[0];

    console.log(`\n📂 ${productName} v${version}`);

    const remainingPlatforms: Platform[] = [];

    for (const platform of app.platform) {
      totalPlatforms++;

      // Extract filename from URL
      const filename = getFilenameFromUrl(platform.location);

      // Parse version and architecture from filename
      const parsed = parseQpkgFilename(filename);
      const architecture = parsed.arch || 'unknown';

      // Extract product name from filename
      const filenameProductName = filename.replace(/_[\d.]+_[^.]+\.qpkg$/, '');

      // Use version from filename for more reliable matching (app.version may be empty or inconsistent)
      const filenameVersion = parsed.version || version;
      const keyWithVersion = `${filenameProductName}-${filenameVersion}-${architecture}`;

      console.log(`  🔍 ${platform.platformID} (${architecture})`);

      // Check if exists in upload progress using exact version match only
      let uploadedFilename: string | undefined;
      if (uploadedIndex.has(keyWithVersion)) {
        uploadedFilename = uploadedIndex.get(keyWithVersion)!;
        console.log(`     ✓ 已上传: ${uploadedFilename}`);
      }

      if (uploadedFilename) {
        totalExisting++;
      } else {
        console.log(`     ➡️  需要下载`);
        totalMissing++;
        remainingPlatforms.push(platform);
      }
    }

    // If there are any platforms left to download, keep the app
    if (remainingPlatforms.length > 0) {
      updatedApps.push({
        ...app,
        platform: remainingPlatforms,
      });

      console.log(`  ℹ️  保留 ${remainingPlatforms.length}/${app.platform.length} 个平台需要下载`);
    } else {
      console.log(`  ✓ 所有平台已上传，删除该软件包`);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 检查结果');
  console.log('='.repeat(60));
  console.log(`  总计软件包: ${apps.length}`);
  console.log(`  总计平台: ${totalPlatforms}`);
  console.log(`  已上传: ${totalExisting}`);
  console.log(`  需要下载: ${totalMissing}`);
  console.log(`  保留软件包: ${updatedApps.length}/${apps.length}`);

  // Save updated JSON
  if (updatedApps.length < apps.length || totalExisting > 0) {
    const updatedData: AppsConfig = {
      plugins: {
        cachechk: appsData.plugins.cachechk,
        item: updatedApps,
      },
    };

    await Bun.write(updateFilePath, JSON.stringify(updatedData, null, 2));
    console.log(`\n✓ 已更新: config/update-apps.json`);
    console.log(`  删除了 ${apps.length - updatedApps.length} 个完全上传的软件包`);
    console.log(`  删除了 ${totalExisting} 个已上传的平台`);
  } else {
    console.log('\n✓ 所有文件都需要下载，无需修改文件');
  }

  console.log('\n' + '='.repeat(60));
  console.log('✓ 检查完成');
  console.log('='.repeat(60));
}

// Run
main().catch(error => {
  console.error('\n❌ Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
