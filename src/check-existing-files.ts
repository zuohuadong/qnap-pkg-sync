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
 * Get product folder name from product name
 */
function getProductFolderName(productName: string): string {
  return productName
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim();
}

/**
 * Get current year-month string
 */
function getCurrentYearMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Parse QPKG filename to extract version and architecture
 */
function parseQpkgFilename(filename: string): { version?: string; arch?: string } {
  // Examples:
  // Apache83_2465.83260_x86_64.qpkg -> version: 2465.83260, arch: x86_64
  // MUSL_CROSS_11.1.5_arm_64.qpkg -> version: 11.1.5, arch: arm_64
  // ADGuard_0.107.24_arm-x41.qpkg -> version: 0.107.24, arch: arm-x41

  const match = filename.match(/_([\d.]+)_([^.]+)\.qpkg$/);
  if (match) {
    return {
      version: match[1],
      arch: match[2],
    };
  }
  return {};
}

/**
 * Check if a file exists in CTFile with the same version
 * Folder structure: CTFILE_FOLDER_ID (qnaporg-github) / ProductName / YYYY-MM / files
 */
async function checkFileExistsInCTFile(
  ctfileClient: CTFileClient,
  rootFolderId: string,
  productName: string,
  version: string,
  architecture: string
): Promise<boolean> {
  try {
    const productFolderName = getProductFolderName(productName);
    const yearMonth = getCurrentYearMonth();

    // Step 1: Find product folder under qnaporg-github (rootFolderId)
    // CTFILE_FOLDER_ID is already the qnaporg-github folder
    const productListResult = await ctfileClient.listFolders(rootFolderId, true);
    const productFolders = productListResult.data || [];
    const productFolder = productFolders.find((f: any) =>
      f.name === productFolderName || f.folder_name === productFolderName
    );

    if (!productFolder) {
      console.log(`  ℹ️  产品文件夹不存在: ${productFolderName}`);
      return false;
    }

    const productFolderId = productFolder.id || productFolder.folder_id;
    console.log(`  ℹ️  找到产品文件夹: ${productFolderName} (ID: ${productFolderId})`);

    // Step 2: Find monthly folder under product folder
    const monthlyListResult = await ctfileClient.listFolders(productFolderId, true);
    const monthlyFolders = monthlyListResult.data || [];
    const monthlyFolder = monthlyFolders.find((f: any) =>
      f.name === yearMonth || f.folder_name === yearMonth
    );

    if (!monthlyFolder) {
      console.log(`  ℹ️  月份文件夹不存在: ${yearMonth}`);
      return false;
    }

    const monthlyFolderId = monthlyFolder.id || monthlyFolder.folder_id;
    console.log(`  ℹ️  找到月份文件夹: ${yearMonth} (ID: ${monthlyFolderId})`);

    // List files in monthly folder
    const normalizedFolderId = monthlyFolderId.startsWith('d') ? monthlyFolderId : `d${monthlyFolderId}`;

    const endpoint = '/public/file/list';
    const session = getEnv('CTFILE_SESSION');
    const baseUrl = 'https://rest.ctfile.com/v1';

    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: session,
        folder_id: normalizedFolderId,
        page: 1,
        page_size: 100,
      }),
    });

    if (!response.ok) {
      console.warn(`  ⚠️  无法列出文件: ${response.status}`);
      return false;
    }

    const result = await response.json();
    const files = result.results || result.data || [];

    // Check if any file matches the version and architecture
    for (const file of files) {
      const filename = file.name || file.file_name || '';
      const parsed = parseQpkgFilename(filename);

      if (parsed.version === version && parsed.arch === architecture) {
        console.log(`  ✓ 文件已存在: ${filename}`);
        return true;
      }
    }

    console.log(`  ℹ️  文件不存在 (版本: ${version}, 架构: ${architecture})`);
    return false;

  } catch (error) {
    console.warn(`  ⚠️  检查文件时出错: ${error instanceof Error ? error.message : error}`);
    return false;
  }
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
