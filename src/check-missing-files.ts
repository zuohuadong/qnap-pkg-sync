#!/usr/bin/env bun

/**
 * Check Missing Files in CTFile
 *
 * 检查 apps.json 中的所有软件包是否都在 CTFile 中存在
 * 将缺失的软件包添加到 update-apps.json 以便下载上传
 *
 * 功能：
 * 1. 读取 config/apps.json（完整软件包列表）
 * 2. 对每个软件包的每个平台（架构），检查是否在 CTFile 中存在
 * 3. 收集所有缺失的软件包
 * 4. 将缺失的软件包写入 config/update-apps.json
 *
 * 用途：
 * - 强制同步模式：确保 CTFile 中有所有软件包
 * - 修复缺失的上传：重新下载并上传意外删除的文件
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { CTFileClient } from './ctfile';
import { loadEnv, getEnv } from './env';
import { checkFileExistsInCTFile, parseQpkgFilename } from './ctfile-utils';
import { getFilenameFromUrl } from './utils/file';
import type { AppsConfig, AppItem, Platform } from './types/index';

/**
 * Main function
 */
async function main() {
  console.log('='.repeat(60));
  console.log('检查 CTFile 中缺失的软件包');
  console.log('='.repeat(60));

  // Load environment
  await loadEnv();

  const session = getEnv('CTFILE_SESSION');
  const rootFolderId = getEnv('CTFILE_FOLDER_ID');

  // Initialize CTFile client
  const ctfileClient = new CTFileClient(session);
  console.log(`\n🔑 CTFile 配置:`);
  console.log(`  Root folder ID: ${rootFolderId}`);

  // Get file paths
  const appsFilePath = join(process.cwd(), 'config', 'apps.json');
  const updateFilePath = join(process.cwd(), 'config', 'update-apps.json');

  // Check if apps.json exists
  if (!existsSync(appsFilePath)) {
    console.log(`\n❌ 未找到 config/apps.json`);
    console.log('   请先运行 fetch 命令获取软件包列表');
    process.exit(1);
  }

  console.log(`\n📋 读取文件: config/apps.json`);

  // Load apps.json
  const appsFile = Bun.file(appsFilePath);
  const appsData: AppsConfig = await appsFile.json();
  const apps = appsData.plugins.item || [];

  console.log(`\n📦 软件包总数: ${apps.length}`);

  if (apps.length === 0) {
    console.log('\n✓ 软件包列表为空');
    return;
  }

  // Check each app
  console.log('\n🔍 开始检查 CTFile 中的文件...\n');

  let totalPlatforms = 0;
  let totalExists = 0;
  let totalMissing = 0;

  const missingApps: AppItem[] = [];

  for (const app of apps) {
    const productName = app.name;
    const version = app.version;

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📂 ${productName}`);
    console.log(`   版本: ${version}`);
    console.log(`   平台数: ${app.platform.length}`);

    const missingPlatforms: Platform[] = [];

    for (const platform of app.platform) {
      totalPlatforms++;

      // Extract filename from URL
      const filename = getFilenameFromUrl(platform.location);

      // Parse version and architecture from filename
      const parsed = parseQpkgFilename(filename);
      const architecture = parsed.arch || 'unknown';
      const fileVersion = parsed.version || version;

      console.log(`\n  🔍 检查平台: ${platform.platformID} (${architecture})`);
      console.log(`     文件名: ${filename}`);

      // Check if file exists in CTFile
      try {
        const exists = await checkFileExistsInCTFile(
          ctfileClient,
          rootFolderId,
          productName,
          fileVersion,
          architecture
        );

        if (exists) {
          console.log(`     ✅ 文件已存在于 CTFile`);
          totalExists++;
        } else {
          console.log(`     ❌ 文件不存在于 CTFile，标记为需要下载`);
          missingPlatforms.push(platform);
          totalMissing++;
        }
      } catch (error) {
        console.log(`     ⚠️  检查时出错: ${error instanceof Error ? error.message : error}`);
        console.log(`     ➡️  保守起见，标记为需要下载`);
        missingPlatforms.push(platform);
        totalMissing++;
      }
    }

    // If there are any platforms missing, add the app to update list
    if (missingPlatforms.length > 0) {
      missingApps.push({
        ...app,
        platform: missingPlatforms,
      });

      console.log(`\n  📌 该软件包有 ${missingPlatforms.length}/${app.platform.length} 个平台需要下载`);
    } else {
      console.log(`\n  ✓ 所有平台都已存在于 CTFile`);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 检查结果');
  console.log('='.repeat(60));
  console.log(`  总计软件包: ${apps.length}`);
  console.log(`  总计平台: ${totalPlatforms}`);
  console.log(`  已存在: ${totalExists}`);
  console.log(`  缺失: ${totalMissing}`);
  console.log(`  需要下载的软件包: ${missingApps.length}`);

  // Save to update-apps.json
  if (missingApps.length > 0) {
    console.log(`\n💾 保存到 config/update-apps.json...`);

    const updateData: AppsConfig = {
      plugins: {
        cachechk: appsData.plugins.cachechk,
        item: missingApps,
      },
    };

    await Bun.write(updateFilePath, JSON.stringify(updateData, null, 2));
    console.log(`✓ 已保存 ${missingApps.length} 个软件包到 update-apps.json`);

    console.log('\n📋 缺失的软件包列表:');
    for (const app of missingApps) {
      console.log(`  - ${app.name} v${app.version} (${app.platform.length} 个平台)`);
    }
  } else {
    console.log('\n✅ 所有软件包都已存在于 CTFile，无需下载');

    // Clear update-apps.json if it exists
    if (existsSync(updateFilePath)) {
      console.log('💾 清空 config/update-apps.json...');
      const emptyData: AppsConfig = {
        plugins: {
          cachechk: appsData.plugins.cachechk,
          item: [],
        },
      };
      await Bun.write(updateFilePath, JSON.stringify(emptyData, null, 2));
      console.log('✓ 已清空 update-apps.json');
    }
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
