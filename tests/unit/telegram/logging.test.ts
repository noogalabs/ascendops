import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  logOutboundMessage,
  logInboundMessage,
  recordInboundTelegram,
  cacheLastSent,
  readLastSent,
  buildRecentHistory,
  readTailSync,
  rotateMessageLogIfNeeded,
  MESSAGE_LOG_ROTATION_BYTES,
  HISTORY_TAIL_BYTES,
} from '../../../src/telegram/logging';
import { TelegramAPI } from '../../../src/telegram/api';
import type { BusPaths, TelegramMessage } from '../../../src/types';

describe('Telegram Logging', () => {
  let testDir: string;
  let previousAdminUsername: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-tg-log-'));
    previousAdminUsername = process.env.ADMIN_USERNAME;
    process.env.ADMIN_USERNAME = 'user';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    if (previousAdminUsername === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = previousAdminUsername;
  });

  describe('logOutboundMessage', () => {
    it('appends correct JSONL format', () => {
      logOutboundMessage(testDir, 'bot1', '12345', 'Hello world', 99);

      const logPath = join(testDir, 'logs', 'bot1', 'outbound-messages.jsonl');
      const content = readFileSync(logPath, 'utf-8').trim();
      const entry = JSON.parse(content);

      expect(entry.agent).toBe('bot1');
      expect(entry.chat_id).toBe('12345');
      expect(entry.text).toBe('Hello world');
      expect(entry.message_id).toBe(99);
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it('appends multiple entries', () => {
      logOutboundMessage(testDir, 'bot1', '111', 'first', 1);
      logOutboundMessage(testDir, 'bot1', '111', 'second', 2);

      const logPath = join(testDir, 'logs', 'bot1', 'outbound-messages.jsonl');
      const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).text).toBe('first');
      expect(JSON.parse(lines[1]).text).toBe('second');
    });
  });

  describe('logInboundMessage', () => {
    it('appends with archived_at and agent', () => {
      const raw = { message_id: 42, text: 'hi', from: { id: 1 } };
      logInboundMessage(testDir, 'bot2', raw);

      const logPath = join(testDir, 'logs', 'bot2', 'inbound-messages.jsonl');
      const content = readFileSync(logPath, 'utf-8').trim();
      const entry = JSON.parse(content);

      expect(entry.message_id).toBe(42);
      expect(entry.text).toBe('hi');
      expect(entry.from).toEqual({ id: 1 });
      expect(entry.agent).toBe('bot2');
      expect(entry.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });
  });

  describe('recordInboundTelegram', () => {
    function buildPaths(ctxRoot: string, agent: string): BusPaths {
      return {
        ctxRoot,
        inbox: join(ctxRoot, 'inbox', agent),
        inflight: join(ctxRoot, 'inflight', agent),
        processed: join(ctxRoot, 'processed', agent),
        logDir: join(ctxRoot, 'logs', agent),
        stateDir: join(ctxRoot, 'state', agent),
        taskDir: join(ctxRoot, 'tasks'),
        approvalDir: join(ctxRoot, 'approvals'),
        analyticsDir: join(ctxRoot, 'analytics'),
        heartbeatDir: join(ctxRoot, 'heartbeats'),
      };
    }

    it('writes both the inbound JSONL row and the telegram_received bus event', () => {
      const paths = buildPaths(testDir, 'spark');
      mkdirSync(paths.stateDir, { recursive: true });

      const msg: TelegramMessage = {
        message_id: 12345,
        date: 1714214400,
        from: { id: 6595584963, is_bot: false, first_name: 'Eros' },
        chat: { id: 6595584963, type: 'private' },
        text: 'Doe maar',
      };

      recordInboundTelegram(paths, testDir, 'spark', 'eros-os', 'Eros', msg);

      const inboundPath = join(testDir, 'logs', 'spark', 'inbound-messages.jsonl');
      const inboundEntry = JSON.parse(readFileSync(inboundPath, 'utf-8').trim());
      expect(inboundEntry).toMatchObject({
        message_id: 12345,
        from: 6595584963,
        from_name: 'Eros',
        chat_id: 6595584963,
        text: 'Doe maar',
        agent: 'spark',
      });

      const today = new Date().toISOString().split('T')[0];
      const eventPath = join(testDir, 'analytics', 'events', 'spark', `${today}.jsonl`);
      const eventEntry = JSON.parse(readFileSync(eventPath, 'utf-8').trim());
      expect(eventEntry).toMatchObject({
        agent: 'spark',
        org: 'eros-os',
        category: 'message',
        event: 'telegram_received',
        severity: 'info',
        metadata: {
          chat_id: '6595584963',
          message_id: 12345,
          from_id: 6595584963,
          from_name: 'Eros',
          has_media: false,
          text_chars: 8,
        },
      });
    });

    it('does NOT refresh last_heartbeat — inbound traffic cannot spoof a wedged agent alive', () => {
      const paths = buildPaths(testDir, 'spark');
      mkdirSync(paths.stateDir, { recursive: true });

      // Wedged agent with a stale heartbeat on disk.
      const staleHeartbeat = JSON.stringify({
        agent: 'spark',
        org: 'eros-os',
        status: 'online',
        current_task: 'wedged',
        mode: 'day',
        last_heartbeat: '2026-04-23T12:00:00Z',
        loop_interval: '4h',
      });
      writeFileSync(join(paths.stateDir, 'heartbeat.json'), staleHeartbeat);

      const msg: TelegramMessage = {
        message_id: 12345,
        date: 1714214400,
        from: { id: 6595584963, is_bot: false, first_name: 'Eros' },
        chat: { id: 6595584963, type: 'private' },
        text: 'Doe maar',
      };

      recordInboundTelegram(paths, testDir, 'spark', 'eros-os', 'Eros', msg);

      // The telegram_received event WAS written…
      const today = new Date().toISOString().split('T')[0];
      const eventPath = join(testDir, 'analytics', 'events', 'spark', `${today}.jsonl`);
      const eventEntry = JSON.parse(readFileSync(eventPath, 'utf-8').trim());
      expect(eventEntry.event).toBe('telegram_received');

      // …but last_heartbeat is byte-identical: the daemon-on-behalf write
      // did not opt into the refresh.
      const after = readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8');
      expect(after).toBe(staleHeartbeat);
    });

    it('marks has_media=true and uses caption length when the message carries a photo', () => {
      const paths = buildPaths(testDir, 'bolt');
      mkdirSync(paths.stateDir, { recursive: true });

      const msg: TelegramMessage = {
        message_id: 99,
        date: 1714214400,
        from: { id: 100, is_bot: false, first_name: 'Eros' },
        chat: { id: 100, type: 'private' },
        caption: 'screenshot of the dashboard',
        photo: [{ file_id: 'a', file_unique_id: 'b', width: 1, height: 1 }],
      };

      recordInboundTelegram(paths, testDir, 'bolt', 'eros-os', 'Eros', msg);

      const today = new Date().toISOString().split('T')[0];
      const eventPath = join(testDir, 'analytics', 'events', 'bolt', `${today}.jsonl`);
      const eventEntry = JSON.parse(readFileSync(eventPath, 'utf-8').trim());
      expect(eventEntry.metadata.has_media).toBe(true);
      expect(eventEntry.metadata.text_chars).toBe('screenshot of the dashboard'.length);
    });

    it('archives reply target metadata for Telegram replies', () => {
      const paths = buildPaths(testDir, 'spark');
      mkdirSync(paths.stateDir, { recursive: true });

      const msg: TelegramMessage = {
        message_id: 124,
        date: 1714214400,
        from: { id: 6595584963, is_bot: false, first_name: 'Eros' },
        chat: { id: 6595584963, type: 'private' },
        text: 'what is this?',
        reply_to_message: {
          message_id: 36,
          date: 1714214300,
          chat: { id: 6595584963, type: 'private' },
          caption: 'Code review done — full HTML breakdown attached.',
          document: { file_id: 'doc1', file_name: 'hermes-review.html' },
        },
      };

      recordInboundTelegram(paths, testDir, 'spark', 'eros-os', 'Eros', msg);

      const inboundPath = join(testDir, 'logs', 'spark', 'inbound-messages.jsonl');
      const inboundEntry = JSON.parse(readFileSync(inboundPath, 'utf-8').trim());
      expect(inboundEntry).toMatchObject({
        message_id: 124,
        text: 'what is this?',
        reply_to_message_id: 36,
        reply_to_text: 'Code review done — full HTML breakdown attached.\n[document: hermes-review.html]',
        reply_to_has_media: true,
      });

      const today = new Date().toISOString().split('T')[0];
      const eventPath = join(testDir, 'analytics', 'events', 'spark', `${today}.jsonl`);
      const eventEntry = JSON.parse(readFileSync(eventPath, 'utf-8').trim());
      expect(eventEntry.metadata).toMatchObject({
        reply_to_message_id: 36,
        reply_to_text_chars: 'Code review done — full HTML breakdown attached.\n[document: hermes-review.html]'.length,
        reply_to_has_media: true,
      });
    });

    it('still writes the JSONL row when the bus-event emit throws', () => {
      const paths = buildPaths(testDir, 'spark');
      mkdirSync(paths.stateDir, { recursive: true });

      writeFileSync(join(testDir, 'analytics'), 'i am a regular file, not a dir', 'utf-8');

      const msg: TelegramMessage = {
        message_id: 7,
        date: 1714214400,
        from: { id: 1, is_bot: false, first_name: 'Eros' },
        chat: { id: 1, type: 'private' },
        text: 'hi',
      };

      const logSpy = vi.fn();
      expect(() => {
        recordInboundTelegram(paths, testDir, 'spark', 'eros-os', 'Eros', msg, logSpy);
      }).not.toThrow();

      const inboundPath = join(testDir, 'logs', 'spark', 'inbound-messages.jsonl');
      const inboundEntry = JSON.parse(readFileSync(inboundPath, 'utf-8').trim());
      expect(inboundEntry.text).toBe('hi');
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe('cacheLastSent / readLastSent', () => {
    it('writes and reads back text', () => {
      cacheLastSent(testDir, 'bot1', '999', 'cached message');
      const result = readLastSent(testDir, 'bot1', '999');
      expect(result).toBe('cached message');
    });

    it('overwrites previous cache', () => {
      cacheLastSent(testDir, 'bot1', '999', 'old');
      cacheLastSent(testDir, 'bot1', '999', 'new');
      expect(readLastSent(testDir, 'bot1', '999')).toBe('new');
    });

    it('returns null when file does not exist', () => {
      const result = readLastSent(testDir, 'bot1', '000');
      expect(result).toBeNull();
    });
  });

  describe('readTailSync (F13)', () => {
    it('returns small files in full', () => {
      const p = join(testDir, 'small.jsonl');
      writeFileSync(p, 'line1\nline2\nline3\n');
      expect(readTailSync(p, 64 * 1024)).toBe('line1\nline2\nline3\n');
    });

    it('returns empty string for an empty file', () => {
      const p = join(testDir, 'empty.jsonl');
      writeFileSync(p, '');
      expect(readTailSync(p, 64 * 1024)).toBe('');
    });

    it('reads only the tail of large files and drops the leading partial line', () => {
      const p = join(testDir, 'large.jsonl');
      const lines: string[] = [];
      for (let i = 0; i < 5000; i++) {
        lines.push(JSON.stringify({ seq: i, pad: 'x'.repeat(50) }));
      }
      writeFileSync(p, lines.join('\n') + '\n');

      const tail = readTailSync(p, 1024); // far smaller than the file
      const tailLines = tail.split('\n').filter(Boolean);

      expect(tail.length).toBeLessThanOrEqual(1024);
      expect(tailLines.length).toBeGreaterThan(0);
      // Every surviving line is complete, valid JSON (partial head was dropped)
      for (const line of tailLines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      // The very last line of the file is present
      expect(JSON.parse(tailLines[tailLines.length - 1]).seq).toBe(4999);
    });
  });

  describe('rotateMessageLogIfNeeded (F13)', () => {
    it('does nothing below the size cap', () => {
      const p = join(testDir, 'out.jsonl');
      writeFileSync(p, 'small\n');
      rotateMessageLogIfNeeded(p);
      expect(readFileSync(p, 'utf-8')).toBe('small\n');
      expect(existsSync(p + '.1')).toBe(false);
    });

    it('does nothing (and does not throw) when the file is missing', () => {
      expect(() => rotateMessageLogIfNeeded(join(testDir, 'nope.jsonl'))).not.toThrow();
    });

    it('rotates to a single .1 backup above the cap', () => {
      const p = join(testDir, 'out.jsonl');
      writeFileSync(p, 'big-old-content\n');
      rotateMessageLogIfNeeded(p, 4); // tiny cap to force rotation
      expect(existsSync(p)).toBe(false); // active log starts fresh on next append
      expect(readFileSync(p + '.1', 'utf-8')).toBe('big-old-content\n');
    });

    it('replaces the previous .1 backup (keeps exactly one generation)', () => {
      const p = join(testDir, 'out.jsonl');
      writeFileSync(p + '.1', 'generation-1\n');
      writeFileSync(p, 'generation-2\n');
      rotateMessageLogIfNeeded(p, 4);
      expect(readFileSync(p + '.1', 'utf-8')).toBe('generation-2\n');
      expect(existsSync(p)).toBe(false);
    });

    it('logOutboundMessage rotates at the real cap and keeps writing', () => {
      const logDir = join(testDir, 'logs', 'bot1');
      mkdirSync(logDir, { recursive: true });
      const logPath = join(logDir, 'outbound-messages.jsonl');
      // Pre-grow the active log past the rotation cap
      writeFileSync(logPath, 'x'.repeat(MESSAGE_LOG_ROTATION_BYTES + 1) + '\n');

      logOutboundMessage(testDir, 'bot1', '111', 'post-rotation entry', 7);

      expect(existsSync(logPath + '.1')).toBe(true);
      const active = readFileSync(logPath, 'utf-8').trim().split('\n');
      expect(active).toHaveLength(1); // only the fresh entry
      expect(JSON.parse(active[0]).text).toBe('post-rotation entry');
    });

    it('logInboundMessage rotates at the real cap and keeps writing', () => {
      const logDir = join(testDir, 'logs', 'bot1');
      mkdirSync(logDir, { recursive: true });
      const logPath = join(logDir, 'inbound-messages.jsonl');
      writeFileSync(logPath, 'x'.repeat(MESSAGE_LOG_ROTATION_BYTES + 1) + '\n');

      logInboundMessage(testDir, 'bot1', { message_id: 1, chat_id: 111, text: 'fresh' });

      expect(existsSync(logPath + '.1')).toBe(true);
      const active = readFileSync(logPath, 'utf-8').trim().split('\n');
      expect(active).toHaveLength(1);
      expect(JSON.parse(active[0]).text).toBe('fresh');
    });
  });

  describe('buildRecentHistory (F13)', () => {
    const CHAT = '12345';

    function writeJsonl(file: string, rows: object[]): void {
      const dir = join(testDir, 'logs', 'bot1');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    }

    it('returns null when no logs exist', () => {
      expect(buildRecentHistory(testDir, 'bot1', CHAT)).toBeNull();
    });

    it('combines inbound + outbound sorted by timestamp on small files', () => {
      writeJsonl('inbound-messages.jsonl', [
        { chat_id: CHAT, text: 'question', timestamp: '2026-06-10T10:00:00Z' },
      ]);
      writeJsonl('outbound-messages.jsonl', [
        { chat_id: CHAT, text: 'answer', timestamp: '2026-06-10T10:01:00Z' },
      ]);

      const history = buildRecentHistory(testDir, 'bot1', CHAT, 6);
      expect(history).toBe('[user]: question\n[bot1]: answer');
    });

    it('filters out other chat ids', () => {
      writeJsonl('inbound-messages.jsonl', [
        { chat_id: CHAT, text: 'mine', timestamp: '2026-06-10T10:00:00Z' },
        { chat_id: '99999', text: 'not mine', timestamp: '2026-06-10T10:01:00Z' },
      ]);
      const history = buildRecentHistory(testDir, 'bot1', CHAT, 6);
      expect(history).toBe('[user]: mine');
    });

    it('returns the most recent messages from a log far larger than the tail window', () => {
      const rows: object[] = [];
      for (let i = 0; i < 20000; i++) {
        rows.push({
          chat_id: CHAT,
          text: `message number ${i}`,
          timestamp: `2026-06-10T10:00:00.${String(i).padStart(5, '0')}Z`,
        });
      }
      writeJsonl('inbound-messages.jsonl', rows);

      // Sanity: the file really exceeds the tail window
      const size = readFileSync(join(testDir, 'logs', 'bot1', 'inbound-messages.jsonl')).length;
      expect(size).toBeGreaterThan(HISTORY_TAIL_BYTES * 4);

      const history = buildRecentHistory(testDir, 'bot1', CHAT, 6);
      expect(history).not.toBeNull();
      const lines = history!.split('\n');
      expect(lines).toHaveLength(6);
      expect(lines[5]).toBe('[user]: message number 19999');
      expect(lines[0]).toBe('[user]: message number 19994');
    });

    it('tops up from the rotated .1 backup right after rotation', () => {
      writeJsonl('inbound-messages.jsonl.1', [
        { chat_id: CHAT, text: 'older from backup', timestamp: '2026-06-10T09:00:00Z' },
        { chat_id: CHAT, text: 'newer from backup', timestamp: '2026-06-10T09:30:00Z' },
      ]);
      writeJsonl('inbound-messages.jsonl', [
        { chat_id: CHAT, text: 'fresh after rotation', timestamp: '2026-06-10T10:00:00Z' },
      ]);

      const history = buildRecentHistory(testDir, 'bot1', CHAT, 6);
      expect(history).toBe(
        '[user]: older from backup\n[user]: newer from backup\n[user]: fresh after rotation',
      );
    });
  });
});

describe('TelegramAPI.sendPhoto', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-tg-photo-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('throws if image file does not exist', async () => {
    const api = new TelegramAPI('test-token');
    await expect(
      api.sendPhoto('123', '/nonexistent/image.jpg'),
    ).rejects.toThrow('Image file not found');
  });

  it('sends multipart form data with correct fields', async () => {
    // Create a fake image file
    const imagePath = join(testDir, 'test.jpg');
    writeFileSync(imagePath, 'fake-image-data');

    const api = new TelegramAPI('test-token');

    // Mock fetch
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, result: { message_id: 55 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await api.sendPhoto('123', imagePath, 'My caption', {
      inline_keyboard: [[{ text: 'OK', callback_data: 'ok' }]],
    });

    expect(result.ok).toBe(true);
    expect(result.result.message_id).toBe(55);

    // Verify fetch was called with correct URL and FormData
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bottest-token/sendPhoto');
    expect(options.method).toBe('POST');

    // Verify it's a FormData body
    const body = options.body;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('chat_id')).toBe('123');
    expect(body.get('caption')).toBe('My caption');
    expect(body.get('reply_markup')).toBe(
      JSON.stringify({ inline_keyboard: [[{ text: 'OK', callback_data: 'ok' }]] }),
    );
    // photo should be a Blob
    const photo = body.get('photo');
    expect(photo).toBeInstanceOf(Blob);
  });

  it('sends without optional fields when not provided', async () => {
    const imagePath = join(testDir, 'test.png');
    writeFileSync(imagePath, 'png-data');

    const api = new TelegramAPI('test-token');
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, result: { message_id: 56 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await api.sendPhoto('456', imagePath);

    const body = mockFetch.mock.calls[0][1].body as FormData;
    expect(body.get('chat_id')).toBe('456');
    expect(body.get('photo')).toBeInstanceOf(Blob);
    expect(body.get('caption')).toBeNull();
    expect(body.get('reply_markup')).toBeNull();
  });
});
