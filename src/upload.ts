import { createReadStream, statSync } from 'node:fs';
import { request } from 'node:https';
import { URL } from 'node:url';

/** Stream a local file to a presigned PUT URL. S3/R2 presigned PUTs require
 *  Content-Length (no chunked encoding), so this uses https.request, not fetch. */
export function putFileToPresignedUrl(
  presignedUrl: string,
  filePath: string,
  headers: Record<string, string> = {},
  onProgress?: (sentBytes: number, totalBytes: number) => void,
): Promise<void> {
  const total = statSync(filePath).size;
  if (total <= 0) return Promise.reject(new Error(`${filePath} is empty`));
  return new Promise((resolve, reject) => {
    const u = new URL(presignedUrl);
    const req = request(
      { method: 'PUT', hostname: u.hostname, path: u.pathname + u.search, headers: { ...headers, 'Content-Length': total } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`Upload failed: HTTP ${res.statusCode} ${body.slice(0, 300)}`));
        });
      },
    );
    req.on('error', reject);
    let sent = 0;
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => { sent += (chunk as Buffer).length; onProgress?.(sent, total); });
    stream.on('error', reject);
    stream.pipe(req);
  });
}
