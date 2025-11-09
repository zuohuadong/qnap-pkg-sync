/**
 * Formatting Utilities
 *
 * Common formatting functions for file sizes, time durations, etc.
 */

/**
 * Format bytes to human-readable string
 *
 * @param bytes - Number of bytes
 * @returns Human-readable string (e.g., "1.23 MB")
 *
 * @example
 * formatBytes(1024) // "1.00 KB"
 * formatBytes(1536000) // "1.46 MB"
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Format time duration in seconds to human-readable string
 *
 * @param seconds - Duration in seconds
 * @returns Human-readable string (e.g., "2m 30s", "1h 15m")
 *
 * @example
 * formatTime(45) // "45s"
 * formatTime(150) // "2m 30s"
 * formatTime(3900) // "1h 5m"
 */
export function formatTime(seconds: number): string {
  if (seconds === Infinity || isNaN(seconds)) return 'calculating...';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * Format time duration in milliseconds to human-readable string
 *
 * @param ms - Duration in milliseconds
 * @returns Human-readable string (e.g., "30s", "2m 30s")
 *
 * @example
 * formatDuration(5000) // "5s"
 * formatDuration(90000) // "1m 30s"
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}
