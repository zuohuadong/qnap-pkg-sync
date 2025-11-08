import { basename } from 'path';

export interface WebDAVConfig {
  serverUrl: string;
  username: string;
  password: string;
  rootPath?: string;
}

export interface WebDAVUploadResult {
  fileName: string;
  remotePath: string;
  downloadUrl: string;
}

/**
 * WebDAV Client for uploading files with retry mechanism
 * Uses native fetch API for all WebDAV operations (MKCOL, PUT, etc.)
 */
export class WebDAVClient {
  private config: WebDAVConfig;
  private maxRetries: number;
  private retryDelay: number;

  constructor(config: WebDAVConfig, maxRetries: number = 3, retryDelay: number = 5000) {
    this.config = {
      ...config,
      rootPath: config.rootPath || '/',
    };
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;
  }

  /**
   * Get Basic Auth header value
   */
  private getAuthHeader(): string {
    return 'Basic ' + Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
  }

  /**
   * Sleep for specified milliseconds
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Format bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }

  /**
   * Create directory if it doesn't exist, recursively creating parent directories
   * Uses native WebDAV MKCOL method
   */
  async ensureDirectory(remotePath: string): Promise<void> {
    // Prepend rootPath if not already included
    const fullPath = remotePath.startsWith(this.config.rootPath!)
      ? remotePath
      : `${this.config.rootPath}${remotePath.startsWith('/') ? remotePath : '/' + remotePath}`;

    // Split path into components and create each level
    const pathParts = fullPath.split('/').filter(p => p);
    let currentPath = '';

    for (const part of pathParts) {
      currentPath += `/${part}`;
      const dirUrl = `${this.config.serverUrl}${currentPath}`;

      try {
        // Try to create the directory using MKCOL method
        const response = await fetch(dirUrl, {
          method: 'MKCOL',
          headers: {
            'Authorization': this.getAuthHeader(),
          },
        });

        if (response.ok || response.status === 201) {
          console.log(`  ✓ Created directory: ${currentPath}`);
        } else if (response.status === 405 || response.status === 409) {
          // 405 = Method Not Allowed (directory exists)
          // 409 = Conflict (directory exists)
          console.log(`  ✓ Directory exists: ${currentPath}`);
        } else {
          console.log(`  ⚠ Could not create directory ${currentPath}: ${response.status} ${response.statusText}`);
        }
      } catch (error: any) {
        // Log but continue - might be permission issue or already exists
        console.log(`  ⚠ Could not create directory ${currentPath}: ${error?.message || error}`);
      }
    }
  }

  /**
   * Upload file using curl command (more stable for large files)
   * Optimized with HTTP/2, TCP tuning, and intelligent retry logic
   */
  private async uploadWithCurl(
    localPath: string,
    uploadUrl: string,
    fileSize: number
  ): Promise<void> {
    const fileName = basename(localPath);
    console.log(`  ⬆️  Uploading with curl (optimized mode)...`);
    const startTime = Date.now();

    try {
      // Use Bun's shell command execution
      // Performance optimizations:
      // --http2: Use HTTP/2 protocol for better multiplexing and performance
      // --tcp-nodelay: Disable Nagle's algorithm for faster small packet transmission
      // --no-buffer: Disable output buffering for real-time progress updates
      // --keepalive-time: Send keepalive probes every 60 seconds to maintain connection
      // --speed-limit/--speed-time: Abort if speed drops below 1KB/s for 30 seconds
      // --compressed: Request compressed transfer encoding (may help with metadata)
      // --retry-all-errors: Retry on all errors, not just transient network issues
      // --ssl-no-revoke: Skip SSL certificate revocation check for faster handshake
      // --max-time: Dynamic timeout based on file size (1 hour per GB, min 1 hour)
      const timeoutSeconds = Math.max(3600, Math.ceil(fileSize / (1024 * 1024 * 1024)) * 3600);

      const result = await Bun.$`curl -T ${localPath} \
        -u ${this.config.username}:${this.config.password} \
        ${uploadUrl} \
        --http2 \
        --tcp-nodelay \
        --no-buffer \
        --keepalive-time 60 \
        --speed-limit 1024 \
        --speed-time 30 \
        --compressed \
        --progress-bar \
        --fail \
        --retry 5 \
        --retry-delay 3 \
        --retry-max-time 300 \
        --retry-all-errors \
        --connect-timeout 30 \
        --max-time ${timeoutSeconds} \
        --ssl-no-revoke`;

      if (result.exitCode !== 0) {
        throw new Error(`curl upload failed with exit code ${result.exitCode}`);
      }

      const elapsed = Date.now() - startTime;
      const speed = (fileSize / elapsed) * 1000;

      console.log(`  ✓ Upload completed`);
      console.log(`  ⏱️  Time: ${(elapsed / 1000).toFixed(2)}s (${this.formatBytes(speed)}/s)`);
    } catch (error) {
      throw new Error(`curl upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Upload file to WebDAV server with retry mechanism using streaming
   */
  async uploadFile(
    localPath: string,
    remotePath: string,
    folderPath?: string
  ): Promise<WebDAVUploadResult> {
    const fileName = basename(localPath);
    const file = Bun.file(localPath);
    const fileSize = file.size;

    // Prepend rootPath to remote path if not already included
    const fullRemotePath = remotePath.startsWith(this.config.rootPath!)
      ? remotePath
      : `${this.config.rootPath}${remotePath.startsWith('/') ? remotePath : '/' + remotePath}`;

    console.log(`\n📤 WebDAV Upload: ${fileName}`);
    console.log(`  Size: ${this.formatBytes(fileSize)}`);
    console.log(`  Remote path: ${fullRemotePath}`);

    // Ensure directory exists (only if folderPath is provided)
    if (folderPath) {
      await this.ensureDirectory(folderPath);
    }

    // Construct full WebDAV URL
    const uploadUrl = `${this.config.serverUrl}${fullRemotePath}`;

    // For large files (>500MB), use curl which is more stable
    const useCurl = fileSize > 500 * 1024 * 1024;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`  🔄 Retry attempt ${attempt}/${this.maxRetries}...`);
          await this.sleep(this.retryDelay * attempt);
        }

        if (useCurl) {
          // Use curl for large files
          await this.uploadWithCurl(localPath, uploadUrl, fileSize);
        } else {
          // Use fetch for smaller files
          console.log(`  ⬆️  Uploading...`);
          const startTime = Date.now();

          // For large files (>500MB), use longer timeout
          const timeoutMs = fileSize > 500 * 1024 * 1024 ? 7200000 : 3600000; // 2 hours for large files, 1 hour otherwise

          // Create an AbortController for timeout
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

          try {
            // Use native fetch with streaming body (Bun.file supports streaming)
            const response = await fetch(uploadUrl, {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': fileSize.toString(),
                'Authorization': this.getAuthHeader(),
              },
              body: file,
              signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
              throw new Error(`WebDAV upload failed: ${response.status} ${response.statusText}`);
            }

            const elapsed = Date.now() - startTime;
            const speed = (fileSize / elapsed) * 1000;

            console.log(`  ✓ WebDAV upload succeeded on attempt ${attempt}`);
            console.log(`  ⏱️  Time: ${(elapsed / 1000).toFixed(2)}s (${this.formatBytes(speed)}/s)`);
          } catch (fetchError) {
            clearTimeout(timeoutId);
            throw fetchError;
          }
        }

        // Construct download URL
        const downloadUrl = uploadUrl;

        return {
          fileName,
          remotePath,
          downloadUrl,
        };
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

    throw new Error(`WebDAV upload failed after ${this.maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Check if file exists on WebDAV server using HEAD request
   */
  async fileExists(remotePath: string): Promise<boolean> {
    try {
      // Prepend rootPath if not already included
      const fullPath = remotePath.startsWith(this.config.rootPath!)
        ? remotePath
        : `${this.config.rootPath}${remotePath.startsWith('/') ? remotePath : '/' + remotePath}`;

      const fileUrl = `${this.config.serverUrl}${fullPath}`;
      const response = await fetch(fileUrl, {
        method: 'HEAD',
        headers: {
          'Authorization': this.getAuthHeader(),
        },
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get file info from WebDAV server using PROPFIND
   */
  async getFileInfo(remotePath: string): Promise<any> {
    // Prepend rootPath if not already included
    const fullPath = remotePath.startsWith(this.config.rootPath!)
      ? remotePath
      : `${this.config.rootPath}${remotePath.startsWith('/') ? remotePath : '/' + remotePath}`;

    const fileUrl = `${this.config.serverUrl}${fullPath}`;
    const response = await fetch(fileUrl, {
      method: 'PROPFIND',
      headers: {
        'Authorization': this.getAuthHeader(),
        'Depth': '0',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get file info: ${response.status} ${response.statusText}`);
    }

    return await response.text();
  }
}
