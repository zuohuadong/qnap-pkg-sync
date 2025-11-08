#!/usr/bin/env bun

/**
 * CTFile API Diagnostic Tool
 *
 * Tests CTFile API endpoints to diagnose upload issues
 */

import { loadEnv, getEnv } from './env';

async function testCTFileAPI() {
  console.log('='.repeat(60));
  console.log('CTFile API Diagnostic Tool');
  console.log('='.repeat(60));

  // Load environment
  await loadEnv();

  const session = getEnv('CTFILE_SESSION');
  const rootFolderId = getEnv('CTFILE_FOLDER_ID');

  console.log(`\n📋 Configuration:`);
  console.log(`  Session: ${session.substring(0, 20)}...`);
  console.log(`  Root Folder ID: ${rootFolderId}`);

  const baseUrl = 'https://rest.ctfile.com/v1';

  // Test 1: List folders
  console.log('\n\n📁 Test 1: List Folders');
  console.log('-'.repeat(60));
  try {
    const listUrl = `${baseUrl}/public/folder/list`;
    const listData = {
      session: session,
      folder_id: rootFolderId.startsWith('d') ? rootFolderId : `d${rootFolderId}`,
      page: 1,
      page_size: 100,
    };

    console.log(`  Request: POST ${listUrl}`);
    console.log(`  Data:`, JSON.stringify(listData, null, 2));

    const listResponse = await fetch(listUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(listData),
    });

    console.log(`\n  Response Status: ${listResponse.status} ${listResponse.statusText}`);

    const listResult = await listResponse.json();
    console.log(`  Response Body:`, JSON.stringify(listResult, null, 2));

    if (listResponse.ok && (listResult.code === 200 || listResult.code === '200')) {
      console.log(`  ✓ List folders successful`);
      console.log(`  Found ${listResult.results?.length || 0} folders`);
    } else {
      console.log(`  ✗ List folders failed`);
    }
  } catch (error) {
    console.error(`  ✗ Error:`, error);
  }

  // Test 2: Create test folder
  console.log('\n\n📁 Test 2: Create Test Folder');
  console.log('-'.repeat(60));
  try {
    const createUrl = `${baseUrl}/public/folder/create`;
    const testFolderName = `test_${Date.now()}`;

    // Normalize parent ID: remove 'd' prefix for create API
    const parentId = rootFolderId.startsWith('d') ? rootFolderId.substring(1) : rootFolderId;

    const createData = {
      session: session,
      name: testFolderName,
      folder_id: parentId,
    };

    console.log(`  Request: POST ${createUrl}`);
    console.log(`  Data:`, JSON.stringify(createData, null, 2));

    const createResponse = await fetch(createUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createData),
    });

    console.log(`\n  Response Status: ${createResponse.status} ${createResponse.statusText}`);
    console.log(`  Response Headers:`, Object.fromEntries(createResponse.headers.entries()));

    const responseText = await createResponse.text();
    console.log(`  Response Body (raw):`, responseText);

    try {
      const createResult = JSON.parse(responseText);
      console.log(`  Response Body (parsed):`, JSON.stringify(createResult, null, 2));

      if (createResponse.ok && (createResult.code === 200 || createResult.code === '200')) {
        console.log(`  ✓ Create folder successful`);
        console.log(`  Folder ID: ${createResult.folder_id || createResult.id}`);
      } else {
        console.log(`  ✗ Create folder failed`);
        console.log(`  Error code: ${createResult.code}`);
        console.log(`  Error message: ${createResult.message}`);
      }
    } catch (parseError) {
      console.error(`  ✗ Failed to parse response as JSON`);
    }
  } catch (error) {
    console.error(`  ✗ Error:`, error);
  }

  // Test 3: Account info (if available)
  console.log('\n\n👤 Test 3: Session Info');
  console.log('-'.repeat(60));
  try {
    const infoUrl = `${baseUrl}/user/info`;
    const infoData = {
      session: session,
    };

    console.log(`  Request: POST ${infoUrl}`);

    const infoResponse = await fetch(infoUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(infoData),
    });

    console.log(`  Response Status: ${infoResponse.status} ${infoResponse.statusText}`);

    const infoResult = await infoResponse.json();
    console.log(`  Response Body:`, JSON.stringify(infoResult, null, 2));

    if (infoResponse.ok && (infoResult.code === 200 || infoResult.code === '200')) {
      console.log(`  ✓ Session is valid`);
    } else {
      console.log(`  ✗ Session may be invalid or expired`);
    }
  } catch (error) {
    console.error(`  ✗ Error:`, error);
  }

  console.log('\n' + '='.repeat(60));
  console.log('Diagnostic Complete');
  console.log('='.repeat(60));
  console.log('\n💡 Next Steps:');
  console.log('  1. Check if session token is valid and has folder creation permissions');
  console.log('  2. Verify account has not reached folder limit');
  console.log('  3. Try logging in to CTFile web interface to check account status');
  console.log('  4. Consider using WebDAV-only mode as workaround');
}

// Run
testCTFileAPI().catch(error => {
  console.error('\n❌ Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
