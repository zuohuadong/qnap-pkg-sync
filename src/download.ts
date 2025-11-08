#!/usr/bin/env bun

/**
 * Main entry point for downloading apps from config/apps.json
 *
 * Usage:
 *   bun run src/download.ts              # Download all apps
 *   bun run src/download.ts "Apache83"   # Download specific app
 */

import { downloadAllApps, downloadAppByName } from './download-apps';

async function main() {
  const args = process.argv.slice(2);

  try {
    if (args.length === 0) {
      // Download all apps
      await downloadAllApps();
    } else {
      // Download specific app
      const appName = args[0];
      await downloadAppByName(appName);
    }
  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
