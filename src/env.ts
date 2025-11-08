/**
 * Load environment variables from .env file
 */
export async function loadEnv(): Promise<void> {
  const envPath = '.env';

  try {
    const file = Bun.file(envPath);
    const text = await file.text();
    const lines = text.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=').trim();
        process.env[key.trim()] = value;
      }
    }
  } catch (error) {
    throw new Error(`Failed to load .env file: ${error}`);
  }
}

/**
 * Get environment variable or throw error
 */
export function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Environment variable ${key} is required but not set`);
  }
  return value;
}

/**
 * Get environment variable with default value
 */
export function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}
