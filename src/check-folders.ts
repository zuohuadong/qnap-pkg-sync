#!/usr/bin/env bun

/**
 * Check existing folder structure in CTFile
 */

import { loadEnv, getEnv } from './env';

async function checkFolderStructure() {
  await loadEnv();

  const session = getEnv('CTFILE_SESSION');
  const rootFolderId = getEnv('CTFILE_FOLDER_ID');
  const baseUrl = 'https://rest.ctfile.com/v1';

  console.log('📂 Checking CTFile folder structure...\n');

  // Function to list folders
  async function listFolders(folderId: string, indent: string = '') {
    const normalizedId = folderId.startsWith('d') ? folderId : `d${folderId}`;

    const response = await fetch(`${baseUrl}/public/folder/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: session,
        folder_id: normalizedId,
        page: 1,
        page_size: 100,
      }),
    });

    const result = await response.json();

    if (result.code === 200) {
      for (const folder of result.results || []) {
        console.log(`${indent}📁 ${folder.name} (${folder.key})`);

        // List subfolders
        const subResponse = await fetch(`${baseUrl}/public/folder/list`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session: session,
            folder_id: folder.key,
            page: 1,
            page_size: 100,
          }),
        });

        const subResult = await subResponse.json();

        if (subResult.code === 200 && subResult.results) {
          for (const subfolder of subResult.results) {
            console.log(`${indent}  📁 ${subfolder.name} (${subfolder.key})`);
          }
        }
      }
    }
  }

  console.log(`Root: ${rootFolderId}\n`);
  await listFolders(rootFolderId);
}

checkFolderStructure().catch(console.error);
