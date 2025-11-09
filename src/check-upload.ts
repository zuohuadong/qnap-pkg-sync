#!/usr/bin/env bun

/**
 * Check Upload Progress Script
 *
 * 验证 upload-progress.json 中记录的文件是否真的存在于 CTFile
 *
 * 功能：
 * 1. 读取 upload-progress.json
 * 2. 对每个记录的文件，检查是否真的存在于 CTFile
 * 3. 清理无效的记录（文件不存在的）
 * 4. 保存更新后的 JSON
 *
 * 用途：
 * - 确保上传记录的准确性
 * - 避免错误地跳过实际未上传的文件
 * - 清理过时或错误的上传记录
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { CTFileClient } from './ctfile';
import { loadEnv, getEnv } from './env';
import { checkFileExistsInCTFile, parseQpkgFilename, getProductFolderName } from './ctfile-utils';

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
 * 从文件名推断产品名称
 * 例如: MUSL_CROSS_11.1.5_x86_64.qpkg -> MUSL Framework
 */
function inferProductNameFromFilename(filename: string): string {
  // 移除版本号和架构后缀
  const baseName = filename.replace(/_[\d.]+_[^.]+\.qpkg$/, '');

  // 处理特殊情况
  const productNameMap: Record<string, string> = {
    'MUSL_CROSS': 'MUSL Framework',
    'ADGuard': 'AdGuard Home (Premium)',
    'Apache83': 'Apache83',
    'Apache84': 'Apache84',
    'OpenList': 'OpenList',
  };

  return productNameMap[baseName] || baseName;
}

/**
 * Main function
 */
async function main() {
  console.log('='.repeat(60));
  console.log('检查 upload-progress.json 中的文件是否存在于 CTFile');
  console.log('='.repeat(60));

  // Load environment
  await loadEnv();

  const session = getEnv('CTFILE_SESSION');
  const rootFolderId = getEnv('CTFILE_FOLDER_ID');

  // Initialize CTFile client
  const ctfileClient = new CTFileClient(session);
  console.log(`\n🔑 CTFile 配置:`);
  console.log(`  Root folder ID: ${rootFolderId}`);

  // Get progress file path
  const progressFilePath = join(process.cwd(), 'config', 'upload-progress.json');

  if (!existsSync(progressFilePath)) {
    console.log(`\n⚠️  未找到 upload-progress.json`);
    console.log('   没有需要检查的上传记录');
    return;
  }

  console.log(`\n📋 使用文件: config/upload-progress.json`);

  // Load upload progress
  const file = Bun.file(progressFilePath);
  const uploadProgress: UploadProgress = await file.json();

  const filenames = Object.keys(uploadProgress);
  console.log(`\n📦 总计 ${filenames.length} 个上传记录`);

  if (filenames.length === 0) {
    console.log('\n✓ 没有需要检查的记录');
    return;
  }

  console.log('\n🔍 开始检查文件...\n');

  let totalChecked = 0;
  let totalExists = 0;
  let totalMissing = 0;

  const validProgress: UploadProgress = {};
  const invalidFiles: string[] = [];

  for (const filename of filenames) {
    totalChecked++;
    const record = uploadProgress[filename];

    console.log(`\n[${totalChecked}/${filenames.length}] ${filename}`);
    console.log(`  上传时间: ${record.uploadDate}`);
    console.log(`  CTFile URL: ${record.ctfileUrl}`);

    // Parse filename to extract version and architecture
    const parsed = parseQpkgFilename(filename);

    if (!parsed.version || !parsed.arch) {
      console.log(`  ⚠️  无法解析文件名，保留记录`);
      validProgress[filename] = record;
      totalExists++;
      continue;
    }

    const version = parsed.version;
    const architecture = parsed.arch;

    // Infer product name from filename
    const productName = inferProductNameFromFilename(filename);

    console.log(`  产品: ${productName}`);
    console.log(`  版本: ${version}`);
    console.log(`  架构: ${architecture}`);

    // Check if file exists in CTFile
    try {
      const exists = await checkFileExistsInCTFile(
        ctfileClient,
        rootFolderId,
        productName,
        version,
        architecture
      );

      if (exists) {
        console.log(`  ✓ 文件存在于 CTFile，保留记录`);
        validProgress[filename] = record;
        totalExists++;
      } else {
        console.log(`  ✗ 文件不存在于 CTFile，删除记录`);
        invalidFiles.push(filename);
        totalMissing++;
      }
    } catch (error) {
      console.log(`  ⚠️  检查时出错: ${error instanceof Error ? error.message : error}`);
      console.log(`  ℹ️  保留记录（保守处理）`);
      validProgress[filename] = record;
      totalExists++;
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 检查结果');
  console.log('='.repeat(60));
  console.log(`  总计记录: ${totalChecked}`);
  console.log(`  文件存在: ${totalExists}`);
  console.log(`  文件缺失: ${totalMissing}`);

  if (invalidFiles.length > 0) {
    console.log('\n🗑️  无效的上传记录:');
    for (const filename of invalidFiles) {
      console.log(`  - ${filename}`);
    }
  }

  // Save updated progress
  if (totalMissing > 0) {
    console.log(`\n💾 保存更新后的 upload-progress.json...`);
    await Bun.write(progressFilePath, JSON.stringify(validProgress, null, 2));
    console.log(`✓ 已删除 ${totalMissing} 个无效记录`);
  } else {
    console.log('\n✓ 所有记录都有效，无需更新文件');
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
