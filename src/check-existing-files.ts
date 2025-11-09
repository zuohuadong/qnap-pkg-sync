#!/usr/bin/env bun

/**
 * Check Existing Files in CTFile
 *
 * 检查 CTFile 中已存在的文件，避免重复下载和上传
 *
 * 功能：
 * 1. 读取 update-apps.json
 * 2. 查询 CTFile 中对应产品文件夹的文件列表
 * 3. 比较版本号和文件名
 * 4. 删除已存在且版本一致的条目
 * 5. 保存清理后的 JSON
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { CTFileClient } from './ctfile';
import { loadEnv, getEnv } from './env';
import { checkFileExistsInCTFile } from './ctfile-utils';

interface AppItem {
  name: string;
  version: string;
  category: string;
  icon: string;
  qpkg?: {
    file: string;
    platform?: {
      architecture: number;
      name: string;
    };
  };
  location?: string;
}

interface AppsJson {
  plugins: {
    item: AppItem[];
  };
}

/**
 * Main function
 */
async function main() {
  console.log('='.repeat(60));
  console.log('检查 CTFile 中已存在的文件');
  console.log('='.repeat(60));

  // Load environment
  await loadEnv();

  const session = getEnv('CTFILE_SESSION');
  const rootFolderId = getEnv('CTFILE_FOLDER_ID');

  // Initialize CTFile client
  const ctfileClient = new CTFileClient(session);
  console.log(`\n🔑 CTFile 配置:`);
  console.log(`  Root folder ID: ${rootFolderId}`);

  // Get config file path from command line or use default
  const args = process.argv.slice(2);
  const configFile = args[0] || 'config/update-apps.json';

  const updateFilePath = configFile.startsWith('/')
    ? configFile
    : join(process.cwd(), configFile);

  if (!existsSync(updateFilePath)) {
    console.log(`\n⚠️  未找到 ${configFile}`);
    console.log('   跳过检查，将下载所有文件');
    return;
  }

  console.log(`\n📋 使用文件: ${configFile}`);

  // Load JSON
  const file = Bun.file(updateFilePath);
  const appsData: AppsJson = await file.json();

  const items = appsData.plugins.item || [];
  console.log(`\n📦 总计 ${items.length} 个软件包`);

  if (items.length === 0) {
    console.log('\n✓ 没有需要检查的软件包');
    return;
  }

  console.log('\n🔍 开始检查文件...\n');

  const itemsToKeep: AppItem[] = [];
  const itemsToRemove: AppItem[] = [];

  for (const item of items) {
    const productName = item.name;
    const version = item.version;
    const architecture = item.qpkg?.platform?.name || 'unknown';

    console.log(`\n📂 ${productName} v${version} [${architecture}]`);

    const exists = await checkFileExistsInCTFile(
      ctfileClient,
      rootFolderId,
      productName,
      version,
      architecture
    );

    if (exists) {
      console.log(`  ➡️  跳过: 文件已存在于 CTFile`);
      itemsToRemove.push(item);
    } else {
      console.log(`  ➡️  保留: 需要下载`);
      itemsToKeep.push(item);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 检查结果');
  console.log('='.repeat(60));
  console.log(`  总计: ${items.length} 个软件包`);
  console.log(`  需要下载: ${itemsToKeep.length}`);
  console.log(`  已存在跳过: ${itemsToRemove.length}`);

  if (itemsToRemove.length > 0) {
    console.log('\n📝 已跳过的软件包:');
    for (const item of itemsToRemove) {
      const arch = item.qpkg?.platform?.name || 'unknown';
      console.log(`  - ${item.name} v${item.version} [${arch}]`);
    }
  }

  // Save updated JSON
  if (itemsToKeep.length < items.length) {
    const updatedData: AppsJson = {
      plugins: {
        item: itemsToKeep,
      },
    };

    await Bun.write(updateFilePath, JSON.stringify(updatedData, null, 2));
    console.log(`\n✓ 已更新: ${configFile}`);
    console.log(`  删除了 ${itemsToRemove.length} 个已存在的软件包`);
  } else {
    console.log('\n✓ 所有软件包都需要下载，无需修改文件');
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
