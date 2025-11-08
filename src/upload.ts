#!/usr/bin/env bun

/**
 * Upload and Share Script
 *
 * Uploads downloaded files to CTFile and generates README with download links
 *
 * Features:
 * - Uploads files to CTFile cloud storage
 * - Automatically creates monthly folders (YYYY-MM format)
 * - Generates README with file info, architecture, update time, and download links
 * - Tracks upload status and generates summary
 *
 * Usage:
 *   bun run src/upload.ts
 */

import { join } from 'path';
import { CTFileClient } from './ctfile';
import { getEnv, loadEnv, getEnvOrDefault } from './env';
import { WebDAVClient } from './webdav-client';

/**
 * Default concurrent upload limit
 * Set to 2 to balance upload speed and system resource usage
 * Can be overridden with UPLOAD_CONCURRENCY environment variable
 */
const DEFAULT_CONCURRENCY = 2;

/**
 * Upload progress tracking file
 */
const UPLOAD_PROGRESS_FILE = 'downloads/upload-progress.json';

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
 * Get current year-month string for folder name
 * Format: YYYY-MM (e.g., 2025-11)
 */
function getCurrentYearMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Load upload progress from file
 */
async function loadUploadProgress(progressFilePath: string): Promise<UploadProgress> {
  const file = Bun.file(progressFilePath);
  if (!await file.exists()) {
    return {};
  }

  try {
    return await file.json();
  } catch (error) {
    console.warn(`  ⚠ Failed to load upload progress: ${error instanceof Error ? error.message : error}`);
    return {};
  }
}

/**
 * Save upload progress to file
 */
async function saveUploadProgress(progressFilePath: string, progress: UploadProgress): Promise<void> {
  try {
    await Bun.write(progressFilePath, JSON.stringify(progress, null, 2));
  } catch (error) {
    console.warn(`  ⚠ Failed to save upload progress: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Execute promises with concurrency limit
 * Each task is wrapped with error handling to ensure failures don't affect other tasks
 * @param tasks Array of task functions that return promises
 * @param concurrency Maximum number of concurrent tasks
 * @returns Array of results in the same order as tasks
 */
async function promiseWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  const executing: Promise<void>[] = [];

  for (const [index, task] of tasks.entries()) {
    // Create a promise that executes the task and stores the result
    // Wrap with error handling to ensure one failure doesn't kill all tasks
    const promise = (async () => {
      try {
        const result = await task();
        results[index] = result;
      } catch (error) {
        // Log error but don't throw - let individual tasks handle their errors
        console.error(`  ⚠ Task ${index + 1} encountered an error: ${error instanceof Error ? error.message : error}`);
        // Store undefined result for failed tasks
        results[index] = undefined as any;
      }
    })();

    // Add to executing pool
    const wrappedPromise = promise.then(() => {
      // Remove from executing pool when done
      executing.splice(executing.indexOf(wrappedPromise), 1);
    }).catch((error) => {
      // Extra safety: catch any unhandled errors
      console.error(`  ⚠ Unhandled error in task wrapper: ${error instanceof Error ? error.message : error}`);
      executing.splice(executing.indexOf(wrappedPromise), 1);
    });

    executing.push(wrappedPromise);

    // Wait if we've reached concurrency limit
    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }

  // Wait for all remaining tasks to complete
  await Promise.all(executing);

  return results;
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

interface PackageMetadata {
  productName: string;
  version: string;
  architecture: string;
  filename: string;
  fileSize: number;
  downloadUrl: string;
  publishedDate: string;
  downloadDate: string;
  signature: string;
}

interface UploadedPackage extends PackageMetadata {
  localPath: string;
  ctfileUrl?: string;
  ctfileShortUrl?: string;
  ctfileFolderUrl?: string;
  uploadDate?: string;
  uploadError?: string;
  uploadMethod?: 'ctfile' | 'webdav'; // Track which method was used
  webdavUrl?: string; // WebDAV download URL if applicable
}

/**
 * Load metadata from JSON file
 */
async function loadMetadata(metadataPath: string): Promise<PackageMetadata[]> {
  const file = Bun.file(metadataPath);
  if (!await file.exists()) {
    throw new Error(`Metadata file not found: ${metadataPath}`);
  }

  return await file.json();
}

/**
 * Match downloaded files with metadata
 */
async function matchFilesWithMetadata(
  packagesDir: string,
  metadata: PackageMetadata[]
): Promise<UploadedPackage[]> {
  // Check if directory exists using shell command
  try {
    const result = await Bun.$`test -d ${packagesDir}`.quiet();
    if (result.exitCode !== 0) {
      throw new Error(`Packages directory not found: ${packagesDir}`);
    }
  } catch {
    throw new Error(`Packages directory not found: ${packagesDir}`);
  }

  const packages: UploadedPackage[] = [];

  for (const meta of metadata) {
    const localPath = join(packagesDir, meta.filename);
    const file = Bun.file(localPath);

    if (await file.exists()) {
      packages.push({
        ...meta,
        localPath,
      });
    } else {
      console.log(`  ⚠ File not found: ${meta.filename}`);
    }
  }

  return packages;
}

/**
 * Get product folder name from product name
 * Sanitize the name for use as a folder name
 */
function getProductFolderName(productName: string): string {
  // Remove special characters and spaces, replace with underscores
  return productName
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim();
}

/**
 * Get or create product folder with monthly subfolder
 * Returns the monthly folder ID, URL, and WebDAV path
 */
async function getProductMonthlyFolder(
  ctfileClient: CTFileClient,
  rootFolderId: string,
  productName: string
): Promise<{ folderId: string; folderUrl: string; webdavPath: string }> {
  const yearMonth = getCurrentYearMonth();
  const productFolderName = getProductFolderName(productName);

  console.log(`\n📁 Setting up folder structure for: ${productName}`);
  console.log(`  Product folder: ${productFolderName}`);
  console.log(`  Monthly folder: ${yearMonth}`);
  console.log(`  Root folder ID: ${rootFolderId}`);

  try {
    // Step 1: Get or create product folder
    const productFolder = await ctfileClient.findOrCreateFolder(
      productFolderName,
      rootFolderId,
      true
    );
    console.log(`  ✓ Product folder ready: ${productFolder.folderId}`);

    // Step 2: Get or create monthly folder under product folder
    const monthlyFolder = await ctfileClient.findOrCreateFolder(
      yearMonth,
      productFolder.folderId,
      true
    );
    console.log(`  ✓ Monthly folder ready: ${monthlyFolder.folderId}`);
    console.log(`  ✓ Folder URL: ${monthlyFolder.folderUrl}`);

    // Build WebDAV path: ProductName/YYYY-MM
    const webdavPath = `${productFolderName}/${yearMonth}`;
    console.log(`  ✓ WebDAV path: ${webdavPath}`);

    return {
      folderId: monthlyFolder.folderId,
      folderUrl: monthlyFolder.folderUrl || '',
      webdavPath: webdavPath,
    };
  } catch (error) {
    console.error(`  ✗ Failed to create folder structure: ${error instanceof Error ? error.message : error}`);
    throw error;
  }
}

/**
 * Upload files to CTFile, organized by product with concurrent upload support
 * Failed uploads will retry using WebDAV as fallback
 */
async function uploadPackages(
  packages: UploadedPackage[],
  ctfileClient: CTFileClient,
  rootFolderId: string,
  webdavClient: WebDAVClient | null,
  concurrency: number = DEFAULT_CONCURRENCY,
  progressFilePath: string = UPLOAD_PROGRESS_FILE
): Promise<UploadedPackage[]> {
  console.log(`\n⬆️  Uploading ${packages.length} files to CTFile...`);
  console.log(`   Concurrent uploads: ${concurrency}`);
  console.log('='.repeat(60));

  // Load upload progress
  console.log('\n📋 Loading upload progress...');
  const uploadProgress = await loadUploadProgress(progressFilePath);
  const uploadedCount = Object.keys(uploadProgress).length;
  console.log(`  ✓ Found ${uploadedCount} previously uploaded files`);

  // Group packages by product
  const groupedPackages = groupPackagesByProduct(packages);
  console.log(`\n📦 Found ${groupedPackages.size} products to upload`);

  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let totalProcessed = 0;
  const totalFiles = packages.length;

  // Upload each product group
  for (const [productName, productPackages] of groupedPackages) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📂 Product: ${productName} (${productPackages.length} files)`);
    console.log('='.repeat(60));

    try {
      // Get or create product/monthly folder structure
      const folderInfo = await getProductMonthlyFolder(
        ctfileClient,
        rootFolderId,
        productName
      );

      // Create upload tasks for all files in this product
      const uploadTasks = productPackages.map((pkg, index) => {
        return async () => {
          const taskNum = totalProcessed + index + 1;

          console.log(
            `\n[${taskNum}/${totalFiles}] ${pkg.productName} - ${pkg.architecture}`
          );
          console.log(`  File: ${pkg.filename}`);
          console.log(`  Size: ${formatBytes(pkg.fileSize)}`);

          // Check if file was already uploaded (using signature as unique identifier)
          const previousUpload = uploadProgress[pkg.filename];
          if (previousUpload && previousUpload.signature === pkg.signature) {
            console.log(`  ⏭️  Already uploaded, skipping...`);
            console.log(`  URL: ${previousUpload.ctfileUrl}`);

            // Restore from progress
            pkg.ctfileUrl = previousUpload.ctfileUrl;
            pkg.ctfileShortUrl = previousUpload.ctfileShortUrl;
            pkg.ctfileFolderUrl = previousUpload.ctfileFolderUrl || folderInfo.folderUrl;
            pkg.uploadDate = previousUpload.uploadDate;

            skipped++;
            console.log(
              `\n  Overall Progress: ${completed + failed + skipped}/${totalFiles} ` +
              `(✓ ${completed} | ⏭ ${skipped} | ✗ ${failed})`
            );
            return;
          }

          try {
            // Check if this is a large file that should use WebDAV directly
            const isLargeFile = pkg.fileSize > parseInt(getEnvOrDefault('MAX_UPLOAD_FILE_SIZE', '1073741824'));

            if (isLargeFile && webdavClient) {
              console.log(`  📦 Large file detected, using WebDAV directly...`);

              // Use WebDAV path from API: ProductName/YYYY-MM/filename
              const remotePath = `/${folderInfo.webdavPath}/${pkg.filename}`;
              const folderPath = `/${folderInfo.webdavPath}`;

              const webdavResult = await webdavClient.uploadFile(
                pkg.localPath,
                remotePath,
                folderPath
              );

              pkg.webdavUrl = webdavResult.downloadUrl;
              pkg.ctfileUrl = webdavResult.downloadUrl; // Use as primary URL
              pkg.ctfileFolderUrl = folderInfo.folderUrl;
              pkg.uploadDate = new Date().toISOString();
              pkg.uploadMethod = 'webdav';

              // Save progress immediately after successful upload
              uploadProgress[pkg.filename] = {
                signature: pkg.signature,
                ctfileUrl: pkg.webdavUrl,
                ctfileFolderUrl: pkg.ctfileFolderUrl,
                uploadDate: pkg.uploadDate,
              };
              await saveUploadProgress(progressFilePath, uploadProgress);

              completed++;
              console.log(`  ✓ Uploaded successfully via WebDAV`);
              console.log(`  URL: ${webdavResult.downloadUrl}`);
            } else {
              // Normal file, use CTFile
              const result = await ctfileClient.uploadFile(folderInfo.folderId, pkg.localPath, true);

              pkg.ctfileUrl = result.downloadUrl;
              pkg.ctfileShortUrl = result.shortUrl;
              pkg.ctfileFolderUrl = folderInfo.folderUrl;
              pkg.uploadDate = new Date().toISOString();
              pkg.uploadMethod = 'ctfile';

              // Save progress immediately after successful upload
              uploadProgress[pkg.filename] = {
                signature: pkg.signature,
                ctfileUrl: pkg.ctfileUrl,
                ctfileShortUrl: pkg.ctfileShortUrl,
                ctfileFolderUrl: pkg.ctfileFolderUrl,
                uploadDate: pkg.uploadDate,
              };
              await saveUploadProgress(progressFilePath, uploadProgress);

              completed++;
              console.log(`  ✓ Uploaded successfully via CTFile`);
              console.log(`  URL: ${result.downloadUrl}`);
              if (result.shortUrl) {
                console.log(`  Short URL: ${result.shortUrl}`);
              }
            }
          } catch (error) {
            const uploadError = error instanceof Error ? error.message : String(error);
            const isLargeFile = pkg.fileSize > parseInt(getEnvOrDefault('MAX_UPLOAD_FILE_SIZE', '1073741824'));

            // If it was a large file that failed WebDAV, don't retry
            if (isLargeFile) {
              console.error(`  ✗ WebDAV upload failed: ${uploadError}`);
              failed++;
              pkg.uploadError = uploadError;
            } else {
              // Normal file failed CTFile, try WebDAV as fallback
              console.error(`  ✗ CTFile upload failed: ${uploadError}`);

              // Try WebDAV as fallback if available
              if (webdavClient) {
                console.log(`  🔄 Retrying with WebDAV...`);

                try {
                  // Use WebDAV path from API: ProductName/YYYY-MM/filename
                  const remotePath = `/${folderInfo.webdavPath}/${pkg.filename}`;
                  const folderPath = `/${folderInfo.webdavPath}`;

                  const webdavResult = await webdavClient.uploadFile(
                    pkg.localPath,
                    remotePath,
                    folderPath
                  );

                  pkg.webdavUrl = webdavResult.downloadUrl;
                  pkg.ctfileUrl = webdavResult.downloadUrl; // Use as primary URL
                  pkg.ctfileFolderUrl = folderInfo.folderUrl;
                  pkg.uploadDate = new Date().toISOString();
                  pkg.uploadMethod = 'webdav';

                  // Save progress after WebDAV upload
                  uploadProgress[pkg.filename] = {
                    signature: pkg.signature,
                    ctfileUrl: pkg.webdavUrl,
                    ctfileFolderUrl: pkg.ctfileFolderUrl,
                    uploadDate: pkg.uploadDate,
                  };
                  await saveUploadProgress(progressFilePath, uploadProgress);

                  completed++;
                  console.log(`  ✓ Uploaded successfully via WebDAV (fallback)`);
                  console.log(`  URL: ${webdavResult.downloadUrl}`);
                } catch (webdavError) {
                  // Both methods failed
                  failed++;
                  pkg.uploadError = `CTFile: ${uploadError}, WebDAV: ${webdavError instanceof Error ? webdavError.message : String(webdavError)}`;
                  console.error(`  ✗ WebDAV upload also failed: ${webdavError instanceof Error ? webdavError.message : String(webdavError)}`);
                }
              } else {
                // No WebDAV fallback available
                failed++;
                pkg.uploadError = uploadError;
              }
            }
          }

          // Show overall progress
          console.log(
            `\n  Overall Progress: ${completed + failed + skipped}/${totalFiles} ` +
            `(✓ ${completed} | ⏭ ${skipped} | ✗ ${failed})`
          );
        };
      });

      // Execute uploads with concurrency limit
      await promiseWithConcurrency(uploadTasks, concurrency);

      // Update total processed after all tasks complete
      totalProcessed += productPackages.length;
    } catch (error) {
      console.error(`\n✗ Failed to setup folders for ${productName}: ${error instanceof Error ? error.message : error}`);
      // Mark all files in this product as failed
      for (const pkg of productPackages) {
        if (!pkg.ctfileUrl) {
          pkg.uploadError = `Folder setup failed: ${error instanceof Error ? error.message : error}`;
          failed++;
          totalProcessed++;
        }
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 Upload Summary');
  console.log('='.repeat(60));
  console.log(`  Total files: ${totalFiles}`);
  console.log(`  ✓ Successful: ${completed}`);
  console.log(`  ⏭  Skipped (already uploaded): ${skipped}`);
  console.log(`  ✗ Failed: ${failed}`);

  return packages;
}

/**
 * Group packages by product name
 */
function groupPackagesByProduct(packages: UploadedPackage[]): Map<string, UploadedPackage[]> {
  const groups = new Map<string, UploadedPackage[]>();

  for (const pkg of packages) {
    if (!groups.has(pkg.productName)) {
      groups.set(pkg.productName, []);
    }
    groups.get(pkg.productName)!.push(pkg);
  }

  return groups;
}

/**
 * Generate README content
 */
function generateReadme(packages: UploadedPackage[]): string {
  const successfulUploads = packages.filter(p => p.ctfileUrl);
  const groupedPackages = groupPackagesByProduct(successfulUploads);

  let readme = '# QNAP Software Packages - Download Links\n\n';
  readme += `Generated on: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n\n`;
  readme += `Total Products: ${groupedPackages.size}\n`;
  readme += `Total Files: ${successfulUploads.length}\n\n`;
  readme += '---\n\n';

  // Table of Contents
  readme += '## Table of Contents\n\n';
  const sortedProducts = Array.from(groupedPackages.keys()).sort();
  for (const productName of sortedProducts) {
    const anchor = productName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    readme += `- [${productName}](#${anchor})\n`;
  }
  readme += '\n---\n\n';

  // Product sections
  for (const productName of sortedProducts) {
    const productPackages = groupedPackages.get(productName)!;

    readme += `## ${productName}\n\n`;

    // Get latest version and update time
    const latestPackage = productPackages.sort((a, b) => {
      const dateA = new Date(a.uploadDate || a.downloadDate).getTime();
      const dateB = new Date(b.uploadDate || b.downloadDate).getTime();
      return dateB - dateA;
    })[0];

    readme += `**Version:** ${latestPackage.version}  \n`;

    const updateDate = new Date(latestPackage.publishedDate);
    readme += `**Update Time:** ${updateDate.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}  \n`;

    // Add folder download link
    if (latestPackage.ctfileFolderUrl) {
      readme += `**📁 Folder Download:** [Browse all files](${latestPackage.ctfileFolderUrl})  \n`;
    }

    readme += '\n### Available Architectures\n\n';
    readme += '| Architecture | Filename | Update Time | File Size | Download Link |\n';
    readme += '|--------------|----------|-------------|-----------|---------------|\n';

    // Sort by architecture
    const sortedPackages = productPackages.sort((a, b) =>
      a.architecture.localeCompare(b.architecture)
    );

    for (const pkg of sortedPackages) {
      const size = formatBytes(pkg.fileSize);
      const downloadUrl = pkg.ctfileShortUrl || pkg.ctfileUrl || 'N/A';
      const linkText = pkg.ctfileShortUrl ? '🔗 Download' : '🔗 Download (Full URL)';
      const updateTime = new Date(pkg.publishedDate).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });

      readme += `| ${pkg.architecture} | \`${pkg.filename}\` | ${updateTime} | ${size} | [${linkText}](${downloadUrl}) |\n`;
    }

    readme += '\n---\n\n';
  }

  // Footer
  readme += '## Notes\n\n';
  readme += '- All files are hosted on CTFile (城通网盘)\n';
  readme += '- Download links are valid as per CTFile retention policy\n';
  readme += '- Files are uploaded from official QNAP qnap.xxx repository\n';
  readme += '- 📁 Use "Folder Download" link to browse and download all files for a product\n';
  readme += '\n---\n\n';
  readme += '*Generated by QNAP Package Sync Tool*\n';

  return readme;
}

/**
 * Save README file
 */
async function saveReadme(content: string, outputPath: string): Promise<void> {
  await Bun.write(outputPath, content);
  console.log(`\n✓ README generated: ${outputPath}`);
  console.log(`  Size: ${(content.length / 1024).toFixed(2)} KB`);
}

/**
 * Main upload and share function
 */
async function main() {
  console.log('='.repeat(60));
  console.log('Upload and Share to CTFile');
  console.log('='.repeat(60));

  // Add signal handlers to gracefully handle termination
  let isShuttingDown = false;

  const handleShutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n\n⚠️  Received ${signal} signal`);
    console.log('Shutting down gracefully...');
    console.log('Upload progress has been saved and will resume on next run.');
    process.exit(0);
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGHUP', () => handleShutdown('SIGHUP'));

  // Load environment variables
  await loadEnv();

  const metadataPath = join(process.cwd(), 'downloads', 'metadata.json');
  const packagesDir = join(process.cwd(), 'downloads');
  const outputReadme = join(process.cwd(), 'downloads', 'PACKAGES.md');

  console.log(`  Metadata: ${metadataPath}`);
  console.log(`  Packages: ${packagesDir}`);
  console.log(`  Output: ${outputReadme}`);

  // Load metadata
  console.log('\n📋 Loading metadata...');
  const metadata = await loadMetadata(metadataPath);
  console.log(`  ✓ Loaded ${metadata.length} entries`);

  // Match files with metadata
  console.log('\n📦 Matching downloaded files...');
  let packages = await matchFilesWithMetadata(packagesDir, metadata);
  console.log(`  ✓ Found ${packages.length} downloaded files`);

  // Check for large files and WebDAV configuration
  const MAX_FILE_SIZE = parseInt(getEnvOrDefault('MAX_UPLOAD_FILE_SIZE', '1073741824')); // 1GB default
  const largeFiles = packages.filter(p => p.fileSize > MAX_FILE_SIZE);

  if (largeFiles.length > 0) {
    console.log(`\n📦 Found ${largeFiles.length} large file(s) (>${(MAX_FILE_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB):`);
    for (const file of largeFiles) {
      console.log(`  - ${file.filename} (${formatBytes(file.fileSize)})`);
    }
    console.log('\n💡 Large files will be uploaded using WebDAV to avoid Bun FormData limitations.');
  }

  if (packages.length === 0) {
    console.log('\n⚠ No files to upload. Please download files first.');
    return;
  }

  // Initialize CTFile client
  console.log('\n🔑 Initializing CTFile client...');
  const session = getEnv('CTFILE_SESSION');
  const rootFolderId = getEnv('CTFILE_FOLDER_ID');

  const ctfileClient = new CTFileClient(session);
  console.log('  ✓ CTFile client ready');
  console.log(`  Root folder ID: ${rootFolderId}`);

  // Get concurrency setting from environment or use default
  const concurrency = process.env.UPLOAD_CONCURRENCY
    ? parseInt(process.env.UPLOAD_CONCURRENCY, 10)
    : DEFAULT_CONCURRENCY;

  // Initialize WebDAV client (required for large files, optional fallback for others)
  let webdavClient: WebDAVClient | null = null;
  const webdavUrl = getEnvOrDefault('WEBDAV_URL', '');
  const webdavUsername = getEnvOrDefault('WEBDAV_USERNAME', '');
  const webdavPassword = getEnvOrDefault('WEBDAV_PASSWORD', '');

  if (webdavUrl && webdavUsername && webdavPassword) {
    console.log('\n🌐 Initializing WebDAV client...');
    webdavClient = new WebDAVClient({
      serverUrl: webdavUrl,
      username: webdavUsername,
      password: webdavPassword,
      rootPath: getEnvOrDefault('WEBDAV_ROOT_PATH', '/'),
    });
    console.log('  ✓ WebDAV client ready');
    console.log(`  Server: ${webdavUrl}`);
    if (largeFiles.length > 0) {
      console.log(`  📦 Will use WebDAV for ${largeFiles.length} large file(s)`);
    }
  } else {
    if (largeFiles.length > 0) {
      console.error('\n❌ WebDAV not configured but required for large files!');
      console.error('  Set WEBDAV_URL, WEBDAV_USERNAME, WEBDAV_PASSWORD in .env');
      console.error('  Large files cannot be uploaded without WebDAV configuration.');
      process.exit(1);
    }
    console.log('\n⚠ WebDAV not configured - no fallback available for failed uploads');
    console.log('  Set WEBDAV_URL, WEBDAV_USERNAME, WEBDAV_PASSWORD to enable WebDAV fallback');
  }

  // Upload files (will create product/monthly folder structure automatically)
  packages = await uploadPackages(packages, ctfileClient, rootFolderId, webdavClient, concurrency);

  // Generate README
  console.log('\n📝 Generating README...');
  const readme = generateReadme(packages);
  await saveReadme(readme, outputReadme);

  // Save updated metadata with CTFile links
  const updatedMetadataPath = metadataPath.replace('.json', '-uploaded.json');
  await Bun.write(updatedMetadataPath, JSON.stringify(packages, null, 2));
  console.log(`✓ Updated metadata saved: ${updatedMetadataPath}`);

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('✓ Upload and share completed!');
  console.log('='.repeat(60));
  console.log(`  README: ${outputReadme}`);
  console.log(`  Metadata: ${updatedMetadataPath}`);

  const failed = packages.filter(p => !p.ctfileUrl).length;

  if (failed > 0) {
    console.log(`\n⚠ ${failed} file(s) failed to upload. Check logs above for details.`);
  }
}

// Run
main().catch(error => {
  console.error('\n❌ Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
