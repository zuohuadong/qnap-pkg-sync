#!/usr/bin/env bun

/**
 * Upload config files to GitHub Actions run artifacts
 *
 * This script uploads all files in the config folder as GitHub Actions artifacts
 * using the `gh run upload` command.
 *
 * Usage:
 *   bun run src/upload-config-artifacts.ts <run-id>
 *   bun run src/upload-config-artifacts.ts           # Auto-detect current run
 *
 * Environment:
 *   GITHUB_RUN_ID - Auto-detected in GitHub Actions
 */

import { join } from 'path';
import { readdirSync, statSync } from 'fs';

async function getCurrentRunId(): Promise<string | null> {
  // Try to get from environment (GitHub Actions)
  const envRunId = process.env.GITHUB_RUN_ID;
  if (envRunId) {
    return envRunId;
  }

  // Try to get from gh CLI (latest run)
  try {
    const result = await Bun.$`gh run list --limit 1 --json databaseId --jq '.[0].databaseId'`.text();
    const runId = result.trim();
    if (runId && runId !== 'null') {
      return runId;
    }
  } catch (error) {
    // Ignore error
  }

  return null;
}

async function uploadFile(runId: string, filePath: string, artifactName: string): Promise<boolean> {
  try {
    console.log(`  📤 Uploading: ${artifactName}`);
    await Bun.$`gh run upload ${runId} ${filePath} --name ${artifactName}`.quiet();
    console.log(`  ✅ Uploaded: ${artifactName}`);
    return true;
  } catch (error) {
    console.error(`  ❌ Failed to upload ${artifactName}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);

  console.log('📦 GitHub Actions Artifact Uploader\n');

  // Get run ID
  let runId: string | null = null;

  if (args.length > 0) {
    runId = args[0];
    console.log(`📋 Using provided run ID: ${runId}`);
  } else {
    console.log('🔍 Auto-detecting run ID...');
    runId = await getCurrentRunId();

    if (runId) {
      console.log(`✓ Detected run ID: ${runId}`);
    } else {
      console.error('\n❌ Error: Could not detect run ID');
      console.error('   Please provide run ID as argument:');
      console.error('   bun run src/upload-config-artifacts.ts <run-id>\n');
      process.exit(1);
    }
  }

  console.log();

  // Get all files in config folder
  const configDir = 'config';
  let files: string[];

  try {
    const entries = readdirSync(configDir);
    files = entries.filter(entry => {
      const fullPath = join(configDir, entry);
      return statSync(fullPath).isFile();
    });
  } catch (error) {
    console.error(`\n❌ Error reading config directory:`, error instanceof Error ? error.message : error);
    process.exit(1);
  }

  if (files.length === 0) {
    console.log('ℹ  No files found in config folder\n');
    return;
  }

  console.log(`📂 Found ${files.length} files in ${configDir}/\n`);

  // Upload each file
  let successCount = 0;
  let failCount = 0;

  for (const file of files) {
    const filePath = join(configDir, file);
    const artifactName = `config-${file}`;

    const success = await uploadFile(runId, filePath, artifactName);
    if (success) {
      successCount++;
    } else {
      failCount++;
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 Upload Summary:');
  console.log(`  ✅ Success: ${successCount}`);
  console.log(`  ❌ Failed: ${failCount}`);
  console.log(`  📦 Total: ${files.length}`);
  console.log('='.repeat(60) + '\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  main();
}
