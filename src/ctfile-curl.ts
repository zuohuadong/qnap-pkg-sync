import { basename, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { CTFileClient, type UploadedFile } from './ctfile';

/**
 * Optional transport for runners where native multipart uploads stall.
 * curl computes multipart Content-Length and bounds connection / idle time.
 * Signed upload URLs are passed on stdin, never printed in arguments or logs.
 */
export class CurlCTFileClient extends CTFileClient {
  async uploadFile(folderId: string, filePath: string, isPublic = true): Promise<UploadedFile> {
    const fileName = basename(filePath);
    const fileSize = Bun.file(filePath).size;
    if (fileSize < 100) throw new Error('CTFile does not support files smaller than 100 bytes');
    const directory = await mkdtemp(join(tmpdir(), 'ctfile-response-'));
    const responsePath = join(directory, 'response.json');
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const uploadUrl = await this.getUploadUrl(folderId, filePath, isPublic);
        const url = new URL(uploadUrl);
        if (url.protocol !== 'https:' || url.username || url.password ||
            (url.hostname !== 'ctfile.com' && !url.hostname.endsWith('.ctfile.com'))) {
          throw new Error('CTFile returned an unsupported upload host');
        }
        console.log(`Uploading ${fileName} (${fileSize} bytes) with curl to ${url.hostname}; attempt ${attempt}`);
        const process = Bun.spawn([
          'curl', '--config', '-', '--silent', '--show-error', '--fail-with-body',
          '--proto', '=https', '--connect-timeout', '30', '--max-time', '1200',
          '--speed-limit', '1024', '--speed-time', '90', '--header', 'Expect:',
          '--form-string', `name=${fileName}`, '--form-string', `filesize=${fileSize}`,
          '--form', `file=@${filePath};filename=${fileName};type=application/octet-stream`,
          '--output', responsePath,
          '--write-out', '{"http_code":%{http_code},"size_upload":%{size_upload},"speed_upload":%{speed_upload},"time_total":%{time_total}}',
        ], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
        // JSON quoting is also valid for this URL-only curl config entry.
        process.stdin.write(`url = ${JSON.stringify(uploadUrl)}\n`);
        process.stdin.end();
        const [exitCode, output] = await Promise.all([
          process.exited,
          new Response(process.stdout).text(),
          // Drain stderr without publishing a potentially signed URL.
          new Response(process.stderr).text(),
        ]);
        let metrics: any;
        try { metrics = JSON.parse(output); } catch { throw new Error(`curl returned invalid transfer metrics (exit ${exitCode})`); }
        console.log(`CTFILE_TRANSFER ${JSON.stringify({ filename: fileName, exitCode, ...metrics })}`);
        if (exitCode !== 0) {
          // Retry only requests that sent no bytes. Ambiguous partial uploads
          // must be resolved by the synchronizer's next remote-listing check.
          if (Number(metrics.size_upload) === 0 && attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }
          throw new Error(`CTFile transfer failed for ${fileName}: curl ${exitCode}, HTTP ${metrics.http_code}`);
        }
        const responseFile = Bun.file(responsePath);
        if (responseFile.size > 1024 * 1024) throw new Error('Unexpectedly large CTFile upload response');
        let response: any;
        try { response = JSON.parse(await responseFile.text()); } catch { throw new Error('CTFile upload did not return JSON'); }
        const item = Array.isArray(response) ? response[0] : response.files?.[0] ?? response.data ?? response;
        const fileId = String(item?.id || item?.file_id || item?.key || '');
        if (!fileId) {
          const fields = Object.keys(response ?? {}).join(', ');
          throw new Error(`CTFile upload response has no file ID (fields: ${fields})`);
        }
        const info = await this.getFileInfo(fileId, folderId, fileName, isPublic);
        return { fileName, fileId, downloadUrl: info.downloadUrl, shortUrl: info.shortUrl };
      }
      throw new Error(`Unable to connect to CTFile for ${fileName}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
