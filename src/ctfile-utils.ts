/**
 * CTFile Utilities
 *
 * Common utilities for working with CTFile storage
 */

import { CTFileClient } from './ctfile';
import { getEnv } from './env';

/**
 * Get product folder name from product name
 * Normalizes product name for use as folder name
 */
export function getProductFolderName(productName: string): string {
  return productName
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim();
}

/**
 * Get current year-month string (YYYY-MM format)
 */
export function getCurrentYearMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Parse QPKG filename to extract version and architecture
 *
 * Examples:
 * - Apache83_2465.83260_x86_64.qpkg -> version: 2465.83260, arch: x86_64
 * - MUSL_CROSS_11.1.5_arm_64.qpkg -> version: 11.1.5, arch: arm_64
 * - ADGuard_0.107.24_arm-x41.qpkg -> version: 0.107.24, arch: arm-x41
 */
export function parseQpkgFilename(filename: string): { version?: string; arch?: string } {
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
 * Check if a file exists in CTFile with the same version and architecture
 *
 * Folder structure: rootFolderId / ProductName / YYYY-MM / files
 *
 * @param ctfileClient CTFile client instance
 * @param rootFolderId Root folder ID (e.g., qnaporg-github folder)
 * @param productName Product name (e.g., "Apache83")
 * @param version Version string (e.g., "2465.83260")
 * @param architecture Architecture string (e.g., "x86_64")
 * @returns true if file exists with same version and architecture
 */
export async function checkFileExistsInCTFile(
  ctfileClient: CTFileClient,
  rootFolderId: string,
  productName: string,
  version: string,
  architecture: string
): Promise<boolean> {
  try {
    const productFolderName = getProductFolderName(productName);
    const yearMonth = getCurrentYearMonth();

    // Step 1: Find product folder under root folder
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

    // Step 3: List files in monthly folder
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

    const result = await response.json() as any;
    const files = result.results || result.data || [];

    // Step 4: Check if any file matches the version and architecture
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
