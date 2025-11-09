/**
 * File System Utilities
 *
 * Common file system operations
 */

import { join, basename } from 'path';

/**
 * Ensure directory exists (create if it doesn't)
 *
 * @param dirPath - Path to directory
 * @throws Error if directory creation fails
 *
 * @example
 * await ensureDir('/path/to/directory');
 */
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    // Try to write a temporary file to test if directory exists
    // If it doesn't exist, this will fail
    const testFile = join(dirPath, '.bun-test');
    await Bun.write(testFile, '');
    // Clean up test file
    await Bun.$`rm -f ${testFile}`.quiet();
  } catch {
    // Directory doesn't exist, create it
    await Bun.$`mkdir -p ${dirPath}`.quiet();
  }
}

/**
 * Extract filename from URL
 *
 * @param url - URL string
 * @returns Filename from URL pathname
 *
 * @example
 * getFilenameFromUrl('https://example.com/files/package.qpkg')
 * // Returns: 'package.qpkg'
 */
export function getFilenameFromUrl(url: string): string {
  const urlObj = new URL(url);
  const pathname = urlObj.pathname;
  return basename(pathname);
}
