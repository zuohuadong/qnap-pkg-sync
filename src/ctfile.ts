import { basename } from 'path';
import { createHash } from 'crypto';
import { formatBytes, formatDuration } from './utils/format';

export interface UploadedFile {
  fileName: string;
  fileId: string;
  downloadUrl: string;
  shortUrl?: string;
}

export interface FolderInfo {
  folderId: string;
  folderName: string;
  parentId?: string;
  folderUrl?: string;
  webdavPath?: string; // WebDAV path relative to server root (e.g., "Apache84/2025-11")
}

/**
 * Calculate MD5 hash of a file using streaming (memory-efficient for large files)
 */
async function calculateMD5(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  const fileSize = file.size;
  const hash = createHash('md5');

  const stream = file.stream();
  const reader = stream.getReader();

  let bytesProcessed = 0;
  let lastLogTime = Date.now();

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      hash.update(value);
      bytesProcessed += value.length;

      // Show progress every 1 second for large files (>100MB)
      const now = Date.now();
      if (fileSize > 100 * 1024 * 1024 && now - lastLogTime > 1000) {
        const progress = ((bytesProcessed / fileSize) * 100).toFixed(1);
        process.stdout.write(`\r  ⏳ Computing MD5: ${progress}%`);
        lastLogTime = now;
      }
    }

    // Clear progress line if it was shown
    if (fileSize > 100 * 1024 * 1024) {
      process.stdout.write('\r\x1b[K'); // Clear line
    }

    return hash.digest('hex');
  } finally {
    reader.releaseLock();
  }
}

export class CTFileClient {
  private session: string;
  private baseUrl = 'https://rest.ctfile.com/v1';
  private maxRetries = 3;
  private retryDelay = 5000; // 5 seconds

  constructor(session: string, maxRetries: number = 3, retryDelay: number = 5000) {
    this.session = session;
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;
  }

  private async request(endpoint: string, data: any): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;

    data.session = this.session;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    // Always try to read response body, even for non-2xx status codes
    let result: any;
    try {
      result = await response.json();
    } catch (parseError) {
      // If we can't parse JSON, throw the HTTP error
      if (!response.ok) {
        throw new Error(`CTFile API error: ${response.status} ${response.statusText}`);
      }
      throw parseError;
    }

    // Debug: log the response for folder operations
    if (endpoint.includes('folder/create') || endpoint.includes('folder/list')) {
      console.log(`  ℹ API Response (${endpoint}):`, JSON.stringify(result).substring(0, 500));
    }

    // Special handling for folder creation when folder exists
    if (result.code === 400 && result.message && result.message.includes('已经存在')) {
      // Return special result to indicate folder exists
      return {
        ...result,
        folder_exists: true,
      };
    }

    // Also check for other error codes that might indicate folder exists
    if (result.message && result.message.includes('已经存在')) {
      console.log(`  ℹ Folder exists (code: ${result.code})`);
      return {
        ...result,
        folder_exists: true,
      };
    }

    // Check for API errors in the response body
    if (result.code !== 200 && result.code !== '200') {
      // Include HTTP status for better debugging
      const httpStatus = response.ok ? '' : ` (HTTP ${response.status})`;
      throw new Error(`CTFile API error${httpStatus}: ${result.message || 'Unknown error'}`);
    }

    return result;
  }

  /**
   * Normalize folder ID - ensure it has 'd' prefix for API calls
   */
  private normalizeFolderId(folderId: string): string {
    if (folderId === '0') return '0'; // Root folder is always '0'
    if (folderId.startsWith('d')) return folderId;
    return `d${folderId}`;
  }

  /**
   * Normalize parent ID for folder creation
   * CTFile API requires parent_id WITHOUT 'd' prefix when creating folders
   */
  private normalizeParentId(parentId: string): string {
    if (parentId === '0') return '0'; // Root folder is always '0'
    if (parentId.startsWith('d')) {
      return parentId.substring(1); // Remove 'd' prefix
    }
    return parentId;
  }

  /**
   * Strip 'd' prefix from folder ID for display
   */
  private stripFolderId(folderId: string): string {
    if (folderId.startsWith('d')) {
      return folderId.substring(1);
    }
    return folderId;
  }

  /**
   * Create a new folder
   */
  async createFolder(folderName: string, parentId: string = '0', isPublic: boolean = true): Promise<FolderInfo> {
    const normalizedParentId = this.normalizeParentId(parentId);
    console.log(`  Creating folder: ${folderName} (parent: ${normalizedParentId})...`);

    const endpoint = isPublic ? '/public/folder/create' : '/private/folder/create';

    const data = {
      name: folderName,
      folder_id: normalizedParentId,  // CTFile uses 'folder_id' to specify parent folder
    };

    const result = await this.request(endpoint, data);

    // Check if folder already exists
    // WARNING: CTFile API bug - when it says "folder exists", it returns
    // the ID of ANY folder with that name in the account, not necessarily
    // the one in the specified parent_id. We need to verify.
    if (result.folder_exists) {
      console.log(`  ⚠ API says folder exists, verifying it's in the correct parent...`);

      // Re-list the parent folder to see if folder was actually created there
      const listResult = await this.listFolders(parentId, isPublic);
      const folders = listResult.data || [];

      const actualFolder = folders.find((f: any) =>
        f.name === folderName || f.folder_name === folderName
      );

      if (actualFolder) {
        const folderId = actualFolder.id || actualFolder.folder_id || '';
        console.log(`  ✓ Folder found in correct parent: ${folderName} (ID: ${folderId})`);
        return {
          folderId,
          folderName,
          parentId,
        };
      } else {
        // Folder exists somewhere else, but not in our parent
        // This is actually an error - CTFile doesn't allow same-named folders in account?
        throw new Error(
          `Folder "${folderName}" exists elsewhere in account but not in parent ${parentId}. ` +
          `CTFile may not allow duplicate folder names. Try using a unique name.`
        );
      }
    }

    console.log(`  ✓ Folder created: ${folderName} (ID: ${result.folder_id || result.id})`);

    return {
      folderId: result.folder_id || result.id || '',
      folderName: folderName,
      parentId: parentId,
    };
  }

  /**
   * List folders in a parent folder
   */
  async listFolders(parentId: string = '0', isPublic: boolean = true): Promise<any> {
    const normalizedParentId = this.normalizeFolderId(parentId);
    console.log(`  Listing folders in parent: ${normalizedParentId}...`);

    const endpoint = isPublic ? '/public/folder/list' : '/private/folder/list';

    const data = {
      folder_id: normalizedParentId,
      page: 1,
      page_size: 100,
    };

    const result = await this.request(endpoint, data);

    // Normalize the response: CTFile API uses 'results' field
    if (result.results && !result.data) {
      // Filter to only include folders (icon === "folder"), not files
      const foldersOnly = result.results.filter((item: any) => item.icon === 'folder');

      result.data = foldersOnly.map((item: any) => ({
        id: item.key?.replace(/^d/, ''), // Remove 'd' prefix with regex
        folder_id: item.key?.replace(/^d/, ''),
        name: item.name,
        folder_name: item.name,
        date: item.date,
      }));
    }

    const folderCount = result.data?.length || 0;
    console.log(`  ✓ Found ${folderCount} folder(s)`);

    // Debug: log folder names for troubleshooting (max 20)
    if (folderCount > 0 && folderCount <= 20) {
      result.data.forEach((f: any) => {
        console.log(`     - "${f.name || f.folder_name}" (ID: ${f.id || f.folder_id})`);
      });
    }

    return result;
  }

  /**
   * Get folder download URL
   */
  getFolderUrl(folderId: string): string {
    const normalizedId = this.normalizeFolderId(folderId);
    return `https://url88.ctfile.com/dir/${normalizedId}`;
  }

  /**
   * Find or create a folder by name
   * Returns existing folder if found, otherwise creates new one
   */
  async findOrCreateFolder(folderName: string, parentId: string = '0', isPublic: boolean = true): Promise<FolderInfo> {
    console.log(`\n📁 Finding or creating folder: ${folderName}`);

    try {
      // List existing folders
      const listResult = await this.listFolders(parentId, isPublic);
      const folders = listResult.data || [];

      // Check if folder exists
      const existingFolder = folders.find((f: any) =>
        f.name === folderName || f.folder_name === folderName
      );

      if (existingFolder) {
        const folderId = existingFolder.id || existingFolder.folder_id || '';
        console.log(`  ✓ Folder already exists: ${folderName} (ID: ${folderId})`);
        return {
          folderId,
          folderName,
          parentId,
          folderUrl: this.getFolderUrl(folderId),
        };
      }

      // Create new folder
      const newFolder = await this.createFolder(folderName, parentId, isPublic);
      return {
        ...newFolder,
        folderUrl: this.getFolderUrl(newFolder.folderId),
      };

    } catch (error) {
      console.error(`  ✗ Error finding/creating folder: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  async getUploadUrl(folderId: string, filePath: string, isPublic: boolean = true): Promise<string> {
    const normalizedFolderId = this.normalizeFolderId(folderId);
    const fileName = basename(filePath);
    const file = Bun.file(filePath);
    const fileSize = file.size;
    const checksum = await calculateMD5(filePath);

    console.log(`  Getting upload URL...`);
    console.log(`    File: ${fileName}`);
    console.log(`    Size: ${fileSize} bytes`);
    console.log(`    MD5: ${checksum}`);

    const endpoint = isPublic ? '/public/file/upload' : '/private/file/upload';

    const data = {
      folder_id: normalizedFolderId,
      checksum,
      size: fileSize.toString(),
      name: fileName,
    };

    const result = await this.request(endpoint, data);

    if (!result.upload_url) {
      throw new Error('No upload URL returned from API');
    }

    console.log(`  ✓ Upload URL obtained`);
    return result.upload_url;
  }

  /**
   * Get file download info after upload
   * CTFile doesn't provide direct file info API, so we construct the URL or list folder files
   */
  async getFileInfo(fileId: string, folderId: string, fileName: string, isPublic: boolean = true): Promise<{ downloadUrl: string; shortUrl?: string }> {
    try {
      // Try to list files in folder to find the uploaded file
      const endpoint = isPublic ? '/public/file/list' : '/private/file/list';

      const data = {
        folder_id: this.normalizeFolderId(folderId),
        page: 1,
        page_size: 100,
      };

      const result = await this.request(endpoint, data);

      // Find the file in the list
      const files = result.results || result.data || [];
      const file = files.find((f: any) =>
        (f.id === fileId || f.file_id === fileId || f.id?.toString() === fileId || f.key === fileId) ||
        (f.name === fileName || f.file_name === fileName)
      );

      if (file && (file.download_url || file.url)) {
        return {
          downloadUrl: file.download_url || file.url,
          shortUrl: file.short_url,
        };
      }

      // Fallback: construct URL based on file ID
      return {
        downloadUrl: `https://url88.ctfile.com/f/${fileId}`,
        shortUrl: undefined,
      };
    } catch (error) {
      // Fallback: construct URL based on file ID
      console.warn(`  ⚠ Failed to get file info, using constructed URL`);
      return {
        downloadUrl: `https://url88.ctfile.com/f/${fileId}`,
        shortUrl: undefined,
      };
    }
  }

  /**
   * Sleep for specified milliseconds
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Display upload progress with spinner
   */
  private startProgressDisplay(fileName: string, fileSize: number): () => void {
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let frame = 0;
    const startTime = Date.now();

    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const speed = (fileSize / elapsed) * 1000; // bytes per second

      // Clear previous line and write new progress
      process.stdout.write('\r\x1b[K'); // Clear line
      process.stdout.write(
        `  ${spinner[frame]} Uploading... ` +
        `${formatBytes(fileSize)} | ` +
        `Elapsed: ${formatDuration(elapsed)} | ` +
        `Speed: ${formatBytes(speed)}/s`
      );

      frame = (frame + 1) % spinner.length;
    }, 100);

    // Return cleanup function
    return () => {
      clearInterval(interval);
      const elapsed = Date.now() - startTime;
      const avgSpeed = (fileSize / elapsed) * 1000;
      process.stdout.write('\r\x1b[K'); // Clear line
      console.log(
        `  ✓ Upload completed in ${formatDuration(elapsed)} ` +
        `(avg speed: ${formatBytes(avgSpeed)}/s)`
      );
    };
  }

  async uploadFile(folderId: string, filePath: string, isPublic: boolean = true): Promise<UploadedFile> {
    const fileName = basename(filePath);
    const file = Bun.file(filePath);
    const fileSize = file.size;

    console.log(`\nUploading to CTFile: ${fileName}`);
    console.log(`  📊 File size: ${formatBytes(fileSize)} (${fileSize} bytes)`);
    console.log(`  📁 Folder ID: ${folderId}`);

    // Log system resources before upload
    if (typeof process.memoryUsage === 'function') {
      const mem = process.memoryUsage();
      console.log(`  💾 Memory usage before upload:`);
      console.log(`     RSS: ${formatBytes(mem.rss)}`);
      console.log(`     Heap Used: ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}`);
      console.log(`     External: ${formatBytes(mem.external)}`);
    }

    // Check minimum file size
    if (fileSize < 100) {
      throw new Error('CTFile does not support files smaller than 100 bytes');
    }

    // Retry logic
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`  🔄 Retry attempt ${attempt}/${this.maxRetries}...`);
          await this.sleep(this.retryDelay * attempt); // Exponential backoff
        }

        // Get upload URL
        const uploadUrl = await this.getUploadUrl(folderId, filePath, isPublic);

        // Create form data with streaming file
        // Bun.file supports streaming, so no need to load entire file to memory
        const formData = new FormData();
        formData.append('name', fileName);
        formData.append('filesize', fileSize.toString());
        formData.append('file', file, fileName);

        // Start progress display
        const stopProgress = this.startProgressDisplay(fileName, fileSize);

        try {
          // Upload file with timeout (60 minutes for large files)
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 60 * 60 * 1000);

          console.log(`  📡 Starting HTTP upload to CTFile...`);
          console.log(`  🌐 Upload URL: ${uploadUrl.substring(0, 50)}...`);

          // Log memory before upload
          const memBefore = process.memoryUsage();
          console.log(`  💾 Memory before upload: RSS=${formatBytes(memBefore.rss)}, Heap=${formatBytes(memBefore.heapUsed)}`);

          const uploadStartTime = Date.now();

          const response = await fetch(uploadUrl, {
            method: 'POST',
            body: formData,
            signal: controller.signal,
            // @ts-ignore - Bun-specific options
            keepalive: true,
          });

          clearTimeout(timeoutId);

          const uploadDuration = Date.now() - uploadStartTime;
          console.log(`  ⏱️  Upload request completed in ${(uploadDuration / 1000).toFixed(2)}s`);
          console.log(`  📥 Response status: ${response.status} ${response.statusText}`);

          // Log memory after upload
          const memAfter = process.memoryUsage();
          console.log(`  💾 Memory after upload: RSS=${formatBytes(memAfter.rss)}, Heap=${formatBytes(memAfter.heapUsed)}`);
          console.log(`  📈 Memory delta: RSS=${formatBytes(memAfter.rss - memBefore.rss)}, Heap=${formatBytes(memAfter.heapUsed - memBefore.heapUsed)}`);

          if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unable to read error response');
            throw new Error(`Upload failed: ${response.status} ${response.statusText} - ${errorText}`);
          }

          console.log(`  📦 Parsing response JSON...`);

          // Get response text first to handle parsing errors
          const responseText = await response.text();
          let result: any;

          try {
            result = JSON.parse(responseText);
          } catch (parseError) {
            console.error(`  ❌ Failed to parse JSON response`);
            console.error(`  📄 Response preview (first 500 chars):`);
            console.error(`     ${responseText.substring(0, 500)}`);
            throw new Error(`Failed to parse JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
          }

          // Stop progress display
          stopProgress();

          // Log the parsed result for debugging
          console.log(`  📋 Upload response:`, JSON.stringify(result).substring(0, 200));

          const fileId = result.id?.toString() || result.file_id?.toString() || '';

          if (!fileId) {
            console.error(`  ⚠️  Response missing file ID. Full response:`, JSON.stringify(result, null, 2));
            throw new Error('No file ID returned from upload');
          }

          console.log(`  ✓ Upload succeeded on attempt ${attempt}`);
          console.log(`  🆔 File ID: ${fileId}`);

          // Get file download URL
          console.log(`  🔗 Fetching download URL...`);
          const fileInfo = await this.getFileInfo(fileId, folderId, fileName, isPublic);

          return {
            fileName,
            fileId,
            downloadUrl: fileInfo.downloadUrl,
            shortUrl: fileInfo.shortUrl,
          };
        } catch (error) {
          // Stop progress display on error
          stopProgress();

          // Log detailed error information
          console.error(`  ❌ Upload error details:`);
          if (error instanceof Error) {
            console.error(`     Name: ${error.name}`);
            console.error(`     Message: ${error.message}`);
            console.error(`     Stack: ${error.stack?.split('\n')[0]}`);

            if (error.name === 'AbortError') {
              throw new Error(`Upload timeout after 60 minutes`);
            }
            throw error;
          }
          throw error;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.maxRetries) {
          console.error(`  ⚠ Attempt ${attempt} failed: ${lastError.message}`);
          console.log(`  ⏳ Waiting ${this.retryDelay * attempt / 1000}s before retry...`);
        } else {
          console.error(`  ✗ All ${this.maxRetries} attempts failed`);
        }
      }
    }

    // If we get here, all retries failed
    throw new Error(`Upload failed after ${this.maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
  }
}
