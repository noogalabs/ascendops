import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { downloadSlackAttachments, SLACK_FILE_LIMITS, type SlackFileAttachment } from '../../../src/slack/slack-files.js';

const TOKEN = 'attachment-test-token-do-not-log';
const PRIVATE_URL = 'https://files.slack.com/files-pri/T-test-F-test/download/example.txt';
const file = (overrides: Partial<SlackFileAttachment> = {}): SlackFileAttachment => ({
  id: 'F-test', name: 'example.txt', url_private: PRIVATE_URL, ...overrides,
});

describe('Slack attachments after authorization', () => {
  let root: string;
  let directory: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'slack-files-test-'));
    directory = join(root, 'private-downloads');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('authenticates the approved host and writes exact bytes in private storage with generated names', async () => {
    const bytes = Uint8Array.of(0, 1, 255, 42);
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes));
    const [result] = await downloadSlackAttachments({
      files: [file({ id: '../../token-in-id', name: '../../token-in-name.txt' })],
      botToken: TOKEN, directory, fetch: fetchMock,
    });
    expect(result.error).toBeUndefined();
    expect(new Uint8Array(await readFile(result.path!))).toEqual(bytes);
    expect(basename(result.path!)).toMatch(/^attachment-[a-f0-9-]+\.txt$/);
    expect(result.path).not.toContain('token-in');
    expect(result.path!.startsWith(directory + '/slack-')).toBe(true);
    expect((await stat(result.path!)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(dirname(result.path!))).mode & 0o777).toBe(0o700);
    expect(fetchMock).toHaveBeenCalledWith(PRIVATE_URL, expect.objectContaining({
      headers: { Authorization: `Bearer ${TOKEN}` }, redirect: 'manual', signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    'http://files.slack.com/file',
    'https://files.slack.com.evil.example/file',
    'https://evil.example/file',
    'https://localhost/file',
    'https://127.0.0.1/file',
    'https://files.slack.com:444/file',
    'file:///etc/passwd',
  ])('never sends credentials to an unapproved URL: %s', async (url_private) => {
    const fetchMock = vi.fn();
    const [result] = await downloadSlackAttachments({ files: [file({ url_private })], botToken: TOKEN, directory, fetch: fetchMock });
    expect(result.error).toMatch(/approved private Slack download URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects credentials embedded in a download URL before authenticating', async () => {
    const url = new URL('https://files.slack.com/file');
    url.username = 'member';
    url.password = 'fixture';
    const fetchMock = vi.fn();
    const [result] = await downloadSlackAttachments({
      files: [file({ url_private: url.href })], botToken: TOKEN, directory, fetch: fetchMock,
    });
    expect(result.error).toMatch(/approved private Slack download URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not follow or authenticate a cross-host redirect', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302, headers: { location: 'https://evil.example/steal' },
    }));
    const [result] = await downloadSlackAttachments({ files: [file()], botToken: TOKEN, directory, fetch: fetchMock });
    expect(result.error).toMatch(/redirect left the approved Slack host/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{ is_external: true }, { mode: 'external' }, { filetype: 'remote' }])(
    'does not attach credentials to remote-file metadata even with an approved-host URL', async (metadata) => {
      const fetchMock = vi.fn();
      const [result] = await downloadSlackAttachments({ files: [file(metadata)], botToken: TOKEN, directory, fetch: fetchMock });
      expect(result.error).toMatch(/External Slack attachments/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('follows bounded same-host redirects after checking each destination', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/approved-next' } }))
      .mockResolvedValueOnce(new Response('downloaded'));
    const [result] = await downloadSlackAttachments({ files: [file()], botToken: TOKEN, directory, fetch: fetchMock });
    expect(result.path).toBeDefined();
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://files.slack.com/approved-next', expect.objectContaining({
      headers: { Authorization: `Bearer ${TOKEN}` }, redirect: 'manual',
    }));
  });

  it('bounds redirect loops', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, {
      status: 307, headers: { location: PRIVATE_URL },
    }));
    const [result] = await downloadSlackAttachments({ files: [file()], botToken: TOKEN, directory, fetch: fetchMock });
    expect(result.error).toMatch(/redirect limit/);
    expect(fetchMock).toHaveBeenCalledTimes(SLACK_FILE_LIMITS.maxRedirects + 1);
  });

  it('rejects oversized declared metadata before making a request', async () => {
    const fetchMock = vi.fn();
    const [result] = await downloadSlackAttachments({
      files: [file({ size: SLACK_FILE_LIMITS.maxFileBytes + 1 })], botToken: TOKEN, directory, fetch: fetchMock,
    });
    expect(result.error).toMatch(/10 MiB file limit/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized Content-Length before saving content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('small', {
      headers: { 'content-length': String(SLACK_FILE_LIMITS.maxFileBytes + 1) },
    }));
    const [result] = await downloadSlackAttachments({ files: [file()], botToken: TOKEN, directory, fetch: fetchMock });
    expect(result.error).toMatch(/byte limit/);
    expect(result.path).toBeUndefined();
  });

  it('enforces streamed size even when Content-Length lies and removes the partial file', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(SLACK_FILE_LIMITS.maxFileBytes));
        controller.enqueue(Uint8Array.of(1));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-length': '1' } }));
    const [result] = await downloadSlackAttachments({ files: [file()], botToken: TOKEN, directory, fetch: fetchMock });
    expect(result.error).toMatch(/byte limit/);
    expect(result.path).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it('enforces a batch byte budget across otherwise valid files', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(new Uint8Array(SLACK_FILE_LIMITS.maxFileBytes)));
    const results = await downloadSlackAttachments({
      files: [file(), file(), file({ size: 1 })], botToken: TOKEN, directory, fetch: fetchMock,
    });
    expect(results.filter((result) => result.path)).toHaveLength(2);
    expect(results[2].error).toMatch(/20 MiB batch limit/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds file requests and result count for an oversized attachment list', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('small'));
    const results = await downloadSlackAttachments({
      files: Array.from({ length: 100 }, () => file()), botToken: TOKEN, directory, fetch: fetchMock,
    });
    expect(fetchMock).toHaveBeenCalledTimes(SLACK_FILE_LIMITS.maxFiles);
    expect(results).toHaveLength(SLACK_FILE_LIMITS.maxFiles + 1);
    expect(results.at(-1)?.error).toMatch(/first four attachments/);
  });

  it('does not use a symlink as private storage', async () => {
    await symlink(root, directory);
    const fetchMock = vi.fn().mockResolvedValue(new Response('small'));
    const [result] = await downloadSlackAttachments({ files: [file()], botToken: TOKEN, directory, fetch: fetchMock });
    expect(result.error).toMatch(/Private attachment storage is unavailable/);
    expect(result.path).toBeUndefined();
  });

  it('reports missing thin file metadata explicitly', async () => {
    const fetchMock = vi.fn();
    const [result] = await downloadSlackAttachments({
      files: [{ id: 'F-test' }], botToken: TOKEN, directory, fetch: fetchMock,
    });
    expect(result.error).toMatch(/no approved private Slack download URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not expose credentials or URLs from failed requests', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error(`${TOKEN} ${PRIVATE_URL}`));
    const [result] = await downloadSlackAttachments({ files: [file()], botToken: TOKEN, directory, fetch: fetchMock });
    expect(result.error).toMatch(/failed or timed out/);
    expect(result.error).not.toContain(TOKEN);
    expect(result.error).not.toContain(PRIVATE_URL);
  });
});
