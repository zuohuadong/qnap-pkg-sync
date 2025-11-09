#!/usr/bin/env bun

/**
 * Force sync from apps.json to update-apps.json
 *
 * This script copies all apps from config/apps.json to config/update-apps.json,
 * forcing a full re-download when running `bun run update`
 *
 * Usage:
 *   bun run src/force-sync.ts
 */

import type { AppsConfig } from './types/index';

async function main() {
  const appsPath = 'config/apps.json';
  const updatePath = 'config/update-apps.json';

  console.log('🔄 Force syncing from apps.json to update-apps.json...\n');

  try {
    // Read apps.json
    const appsFile = Bun.file(appsPath);
    if (!await appsFile.exists()) {
      throw new Error(`Config file not found: ${appsPath}`);
    }

    const config: AppsConfig = await appsFile.json();
    const appCount = config.plugins.item.length;

    console.log(`📂 Found ${appCount} apps in ${appsPath}`);

    // Calculate total platforms
    const totalPlatforms = config.plugins.item.reduce(
      (sum, app) => sum + app.platform.length,
      0
    );
    console.log(`📦 Total packages across all platforms: ${totalPlatforms}`);

    // Write to update-apps.json
    await Bun.write(updatePath, JSON.stringify(config, null, 2));

    const stats = Bun.file(updatePath).size;
    console.log(`\n✅ Successfully synced to ${updatePath}`);
    console.log(`   File size: ${(stats / 1024).toFixed(1)} KB`);
    console.log(`   Apps: ${appCount}`);
    console.log(`   Packages: ${totalPlatforms}`);

    console.log('\n💡 Next steps:');
    console.log('   Run: bun run update');
    console.log('   This will download all apps as if they were new updates.\n');

  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  main();
}
