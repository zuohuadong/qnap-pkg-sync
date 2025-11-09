/**
 * Fetch XML from QNAP with authentication and convert to JSON
 *
 * Usage:
 *   bun run src/fetch-xml.ts
 */

import { parseStringPromise } from 'xml2js';
import { loadEnv, getEnv } from './env';
import type { Platform, AppItem, AppsConfig } from './types';

interface FetchXmlOptions {
  url: string;
  username: string;
  password: string;
  outputPath?: string;
}

/**
 * Fetch XML content with Basic Authentication
 */
async function fetchXml(options: FetchXmlOptions): Promise<string> {
  const { url, username, password } = options;

  console.log('📥 Fetching XML from:', url);

  // Create Basic Auth header
  const credentials = btoa(`${username}:${password}`);
  const headers = {
    'Authorization': `Basic ${credentials}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };

  try {
    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    console.log('📄 Content-Type:', contentType);

    const xml = await response.text();
    console.log(`✓ Fetched ${(xml.length / 1024).toFixed(1)} KB of XML data`);

    return xml;
  } catch (error) {
    throw new Error(`Failed to fetch XML: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Convert XML to JSON
 */
async function xmlToJson(xml: string): Promise<any> {
  console.log('🔄 Converting XML to JSON...');

  try {
    const result = await parseStringPromise(xml, {
      explicitArray: false,
      mergeAttrs: true,
      trim: true,
    });

    console.log('✓ XML converted to JSON successfully');
    return result;
  } catch (error) {
    throw new Error(`Failed to parse XML: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Save JSON to file using Bun.write
 */
async function saveJson(data: any, outputPath: string): Promise<void> {
  console.log(`💾 Saving JSON to: ${outputPath}`);

  try {
    const jsonString = JSON.stringify(data, null, 2);
    await Bun.write(outputPath, jsonString);

    const stats = Bun.file(outputPath).size;
    console.log(`✓ Saved ${(stats / 1024).toFixed(1)} KB to ${outputPath}`);
  } catch (error) {
    throw new Error(`Failed to save JSON: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Compare two apps configs and find differences (new or updated apps)
 */
function findDifferences(oldConfig: AppsConfig | null, newConfig: AppsConfig): AppsConfig {
  // If no old config, all apps are new
  if (!oldConfig || !oldConfig.plugins || !oldConfig.plugins.item) {
    return newConfig;
  }

  const oldApps = oldConfig.plugins.item;
  const newApps = newConfig.plugins.item;
  const differences: AppItem[] = [];

  // Create a map of old apps for quick lookup
  const oldAppsMap = new Map<string, AppItem>();
  for (const app of oldApps) {
    oldAppsMap.set(app.internalName || app.name, app);
  }

  // Find new or updated apps
  for (const newApp of newApps) {
    const key = newApp.internalName || newApp.name;
    const oldApp = oldAppsMap.get(key);

    if (!oldApp) {
      // New app
      differences.push(newApp);
    } else if (oldApp.version !== newApp.version) {
      // Version updated
      differences.push(newApp);
    } else {
      // Check if platforms changed
      const oldPlatformsSet = new Set(
        oldApp.platform.map(p => `${p.platformID}:${p.location}`)
      );

      // Check if there are new platforms or updated platforms
      let hasChanges = false;
      for (const platform of newApp.platform) {
        const key = `${platform.platformID}:${platform.location}`;
        if (!oldPlatformsSet.has(key)) {
          hasChanges = true;
          break;
        }
      }

      if (hasChanges) {
        differences.push(newApp);
      }
    }
  }

  return {
    plugins: {
      cachechk: newConfig.plugins.cachechk,
      item: differences,
    },
  };
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('='.repeat(60));
    console.log('QNAP XML Fetcher');
    console.log('='.repeat(60));
    console.log();

    // Load environment variables
    await loadEnv();

    // Get configuration from .env
    const url = getEnv('QNAP_DOWNLOAD_URL');
    const username = getEnv('QNAP_USERNAME');
    const password = getEnv('QNAP_PASSWORD');
    const outputPath = process.env.OUTPUT_PATH || 'config/apps.json';
    const updatePath = 'config/update-apps.json';

    console.log('📋 Configuration:');
    console.log(`   URL: ${url}`);
    console.log(`   Username: ${username}`);
    console.log(`   Output: ${outputPath}`);
    console.log(`   Update tracking: ${updatePath}`);
    console.log();

    // Read old config if exists
    let oldConfig: AppsConfig | null = null;
    const oldConfigFile = Bun.file(outputPath);
    if (await oldConfigFile.exists()) {
      console.log('📂 Reading existing config for comparison...');
      try {
        oldConfig = await oldConfigFile.json();
        console.log(`✓ Found ${oldConfig?.plugins?.item?.length || 0} existing apps`);
      } catch (error) {
        console.log('⚠ Failed to read old config, treating as new');
      }
    } else {
      console.log('ℹ No existing config found, all apps will be new');
    }
    console.log();

    // Fetch XML
    const xml = await fetchXml({ url, username, password });

    // Convert to JSON
    const json = await xmlToJson(xml);

    // Find differences
    console.log('🔍 Comparing with previous version...');
    const differences = findDifferences(oldConfig, json);
    const diffCount = differences.plugins.item.length;
    console.log(`✓ Found ${diffCount} new or updated apps`);

    if (diffCount > 0) {
      console.log();
      console.log('📝 New or updated apps:');
      for (const app of differences.plugins.item) {
        const oldApp = oldConfig?.plugins?.item?.find(
          a => (a.internalName || a.name) === (app.internalName || app.name)
        );
        if (oldApp && oldApp.version !== app.version) {
          console.log(`   • ${app.name}: ${oldApp.version} → ${app.version} (updated)`);
        } else {
          console.log(`   • ${app.name} v${app.version} (new)`);
        }
      }
    }
    console.log();

    // Save full config
    await saveJson(json, outputPath);

    // Save differences to update-apps.json
    if (diffCount > 0) {
      console.log(`💾 Saving ${diffCount} updates to: ${updatePath}`);
      await saveJson(differences, updatePath);
      const stats = Bun.file(updatePath).size;
      console.log(`✓ Saved ${(stats / 1024).toFixed(1)} KB to ${updatePath}`);
    } else {
      // Remove update-apps.json if no updates
      const updateFile = Bun.file(updatePath);
      if (await updateFile.exists()) {
        console.log(`🗑️  No updates found, removing ${updatePath}`);
        await Bun.$`rm -f ${updatePath}`.quiet();
      }
    }

    console.log();
    console.log('='.repeat(60));
    console.log('✅ Successfully completed!');
    console.log('='.repeat(60));

  } catch (error) {
    console.error();
    console.error('❌ Error:', error instanceof Error ? error.message : error);
    console.error();
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  main();
}

export { fetchXml, xmlToJson, saveJson };
