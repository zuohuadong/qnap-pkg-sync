/**
 * Common Type Definitions
 *
 * Shared interfaces and types used across the application
 */

/**
 * Platform information for a downloadable package
 */
export interface Platform {
  platformID: string;
  location: string;
  signature: string;
}

/**
 * Application/Package item from apps.json
 */
export interface AppItem {
  name: string;
  version: string;
  platform: Platform[];
  internalName: string;
}

/**
 * Apps configuration file structure (apps.json, update-apps.json)
 */
export interface AppsConfig {
  plugins: {
    cachechk: string;
    item: AppItem[];
  };
}

/**
 * Package metadata for downloaded/uploaded files
 */
export interface PackageMetadata {
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

/**
 * Uploaded package with additional upload information
 */
export interface UploadedPackage extends PackageMetadata {
  localPath: string;
  ctfileUrl?: string;
  ctfileShortUrl?: string;
  ctfileFolderUrl?: string;
  uploadDate?: string;
  webdavUrl?: string;
}

/**
 * Download options for file download
 */
export interface DownloadOptions {
  url: string;
  outputPath: string;
  signature: string;
  headers?: Record<string, string>;
  maxRetries?: number;
  showProgress?: boolean;
}

/**
 * Download result
 */
export interface DownloadResult {
  success: boolean;
  filePath: string;
  fileSize: number;
  verified: boolean;
  error?: string;
}
