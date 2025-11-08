/**
 * Download only updated apps from config/update-apps.json
 *
 * This script downloads only the apps that have been updated since the last fetch,
 * as recorded in config/update-apps.json. After successful download, the app is
 * removed from update-apps.json.
 *
 * Usage:
 *   bun run src/download-updates.ts
 */

import { downloadUpdates } from './download-apps';

async function main() {
  try {
    await downloadUpdates();
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  main();
}
