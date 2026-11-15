#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const config = await readFile('/dev/stdin', 'utf8');
const configUrl = JSON.parse(config.match(/^url = (.+)$/m)[1]);
const credentials = config.match(/^user = (.+)$/m);
const method = args[args.indexOf('--request') + 1];
const status = Number(process.env.CURL_TEST_STATUS || 207);
const responsePath = args[args.indexOf('--output') + 1];
const body = `<multistatus xmlns="DAV:"><response><href>${new URL(configUrl).pathname}</href>
  <propstat><prop><getcontentlength>1024</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat>
  </response></multistatus>`;
await writeFile(responsePath, body);
await writeFile(process.env.CURL_TEST_CAPTURE, JSON.stringify({
  args, method, hasCredentials: Boolean(credentials),
  credentialsMatch: credentials && JSON.parse(credentials[1]) === 'PRIVATE_USER:PRIVATE_PASSWORD',
  hasSignedUrl: new URL(configUrl).searchParams.has('token'),
}));
process.stdout.write(`${status} ${method === 'PUT' ? 1024 : 0}`);
process.exitCode = status >= 400 ? 22 : 0;
