/** Download authorized Slack attachments after the caller's route/trust gates. */
import { chmod, lstat, mkdir, mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute, join } from 'node:path';

export interface SlackFileAttachment {
  id: string;
  name?: string;
  size?: number;
  mimetype?: string;
  mode?: string;
  is_external?: boolean;
  filetype?: string;
  url_private?: string;
  url_private_download?: string;
}

export interface SlackAttachmentResult {
  id: string;
  name: string;
  path?: string;
  error?: string;
}

export const SLACK_FILE_LIMITS = {
  maxFiles: 4,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  timeoutMs: 15_000,
  maxRedirects: 3,
} as const;

const SAFE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.pdf', '.txt', '.csv',
  '.json', '.md', '.docx', '.xlsx', '.pptx', '.zip', '.mp3', '.mp4', '.wav',
]);

function safePart(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  // Treat both platform path separators as untrusted. Restrict the stored name
  // as well as removing traversal, control characters, and shell punctuation.
  const basename = value.split(/[\\/]/).pop() ?? '';
  const safe = basename.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, maxLength);
  return safe || fallback;
}

function approvedUrl(raw: unknown, base?: URL): URL | null {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com'
      || url.port !== '' || url.username !== '' || url.password !== '') return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Never logs URL/token/raw network errors. Only exact HTTPS files.slack.com
 * targets receive Authorization, including every manually followed redirect.
 * Uses streaming byte limits and private, unique local directories. Retention
 * of successful downloads is owned by the installation, not this helper.
 */
export async function downloadSlackAttachments(opts: {
  files: readonly SlackFileAttachment[];
  botToken: string;
  directory: string;
  fetch?: typeof globalThis.fetch;
}): Promise<SlackAttachmentResult[]> {
  const results: SlackAttachmentResult[] = [];
  const request = opts.fetch ?? globalThis.fetch;
  let batchDirectory: string | undefined;
  let totalBytes = 0;
  for (const [index, file] of opts.files.slice(0, SLACK_FILE_LIMITS.maxFiles).entries()) {
    const id = safePart(file?.id, `attachment-${index + 1}`, 80);
    const name = safePart(file?.name, id, 120);
    const result: SlackAttachmentResult = { id, name };
    let localPath: string | undefined;
    try {
      if (!opts.botToken) throw new Error('Slack bot credentials are unavailable.');
      if (!isAbsolute(opts.directory)) throw new Error('Private attachment directory must be absolute.');
      if (!file || typeof file !== 'object') throw new Error('Attachment metadata is invalid.');
      if (file.is_external === true || file.mode === 'external' || file.filetype === 'remote') {
        throw new Error('External Slack attachments are not downloaded.');
      }
      if (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 0)) {
        throw new Error('Attachment size metadata is invalid.');
      }
      if (file.size !== undefined && file.size > SLACK_FILE_LIMITS.maxFileBytes) {
        throw new Error('Attachment exceeds the 10 MiB file limit.');
      }
      if (totalBytes >= SLACK_FILE_LIMITS.maxTotalBytes
        || (file.size !== undefined && file.size > SLACK_FILE_LIMITS.maxTotalBytes - totalBytes)) {
        throw new Error('Attachment exceeds the 20 MiB batch limit.');
      }
      let url = approvedUrl(file.url_private_download ?? file.url_private);
      if (!url) throw new Error('Attachment has no approved private Slack download URL.');
      const signal = AbortSignal.timeout(SLACK_FILE_LIMITS.timeoutMs);
      let response: Response | undefined;
      for (let redirects = 0; redirects <= SLACK_FILE_LIMITS.maxRedirects; redirects++) {
        try {
          response = await request(url.href, {
            headers: { Authorization: `Bearer ${opts.botToken}` },
            redirect: 'manual',
            signal,
          });
        } catch {
          throw new Error('Attachment download failed or timed out.');
        }
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const next = approvedUrl(response.headers.get('location'), url);
        await response.body?.cancel().catch(() => {});
        if (!next) throw new Error('Attachment redirect left the approved Slack host.');
        if (redirects === SLACK_FILE_LIMITS.maxRedirects) throw new Error('Attachment redirect limit exceeded.');
        url = next;
      }
      if (!response?.ok) {
        await response?.body?.cancel().catch(() => {});
        throw new Error('Slack rejected the attachment download; check file access and files:read.');
      }
      const length = response.headers.get('content-length');
      if (length && /^\d+$/.test(length)) {
        const bytes = Number(length);
        if (bytes > SLACK_FILE_LIMITS.maxFileBytes || bytes > SLACK_FILE_LIMITS.maxTotalBytes - totalBytes) {
          await response.body?.cancel().catch(() => {});
          throw new Error('Attachment exceeds the file or batch byte limit.');
        }
      }
      if (!response.body) throw new Error('Attachment download returned no file content.');
      if (!batchDirectory) {
        try {
          await mkdir(opts.directory, { recursive: true, mode: 0o700 });
          const stat = await lstat(opts.directory);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
          await chmod(opts.directory, 0o700);
          batchDirectory = await mkdtemp(join(opts.directory, 'slack-'));
          await chmod(batchDirectory, 0o700);
        } catch {
          await response.body.cancel().catch(() => {});
          throw new Error('Private attachment storage is unavailable.');
        }
      }
      // File names and even ids are untrusted event data: do not put either
      // into the usable local path (they can contain a credential). Preserve
      // only a known extension for the reader and generate the remaining name.
      const extension = extname(name).toLowerCase();
      localPath = join(batchDirectory, `attachment-${randomUUID()}${SAFE_EXTENSIONS.has(extension) ? extension : '.bin'}`);
      const reader = response.body.getReader();
      let fileBytes = 0;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(localPath, 'wx', 0o600);
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          fileBytes += value.byteLength;
          totalBytes += value.byteLength;
          if (fileBytes > SLACK_FILE_LIMITS.maxFileBytes || totalBytes > SLACK_FILE_LIMITS.maxTotalBytes) {
            throw new Error('Attachment exceeds the file or batch byte limit.');
          }
          let written = 0;
          while (written < value.byteLength) {
            const { bytesWritten } = await handle.write(value, written, value.byteLength - written);
            if (bytesWritten === 0) throw new Error('Attachment write made no progress.');
            written += bytesWritten;
          }
        }
        result.path = localPath;
      } catch (error) {
        await reader.cancel().catch(() => {});
        // Preserve only our fixed size error; network/filesystem exceptions
        // can contain raw URLs, credentials, or local implementation details.
        if (error instanceof Error && error.message === 'Attachment exceeds the file or batch byte limit.') throw error;
        throw new Error('Attachment content could not be saved completely.');
      } finally {
        await handle?.close().catch(() => {});
        reader.releaseLock();
      }
    } catch (error) {
      if (localPath) await unlink(localPath).catch(() => {});
      result.error = error instanceof Error ? error.message : 'Attachment download failed.';
    }
    results.push(result);
  }
  if (opts.files.length > SLACK_FILE_LIMITS.maxFiles) {
    results.push({ id: 'additional-files', name: 'Additional attachments', error: 'Only the first four attachments can be downloaded per message.' });
  }
  if (batchDirectory && !results.some((result) => result.path)) await rmdir(batchDirectory).catch(() => {});
  return results;
}
