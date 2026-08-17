import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  existsSync,
  symlinkSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  InboxLockUnavailableError,
  sendMessage,
  checkInbox,
  ackInbox,
  pruneProcessed,
  PROCESSED_TTL_DAYS,
} from '../../../src/bus/message';
import { acquireLock, releaseLock } from '../../../src/utils/lock';
import { resolvePaths } from '../../../src/utils/paths';
import type { BusPaths } from '../../../src/types';

describe('Message Bus', () => {
  let testDir: string;
  let senderPaths: BusPaths;
  let receiverPaths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-bus-test-'));
    // Override ctxRoot to use temp directory
    senderPaths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'sender'),
      inflight: join(testDir, 'inflight', 'sender'),
      processed: join(testDir, 'processed', 'sender'),
      logDir: join(testDir, 'logs', 'sender'),
      stateDir: join(testDir, 'state', 'sender'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    receiverPaths = {
      ...senderPaths,
      inbox: join(testDir, 'inbox', 'receiver'),
      inflight: join(testDir, 'inflight', 'receiver'),
      processed: join(testDir, 'processed', 'receiver'),
      logDir: join(testDir, 'logs', 'receiver'),
      stateDir: join(testDir, 'state', 'receiver'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('sendMessage', () => {
    it('creates a JSON file in receiver inbox', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'Hello');
      expect(msgId).toBeTruthy();

      const receiverInbox = join(testDir, 'inbox', 'receiver');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      expect(files.length).toBe(1);

      // Verify filename format: {pnum}-{epochMs}-from-{sender}-{rand5}.json
      expect(files[0]).toMatch(/^2-\d+-from-sender-[a-z0-9]{5}\.json$/);
    });

    it('scrubs SSNs from the message text at the primitive (covers every inbox writer)', () => {
      sendMessage(senderPaths, 'paul', 'boris', 'normal',
        'tenant SSN 123-45-6789 and 987654321 under ssn');
      const receiverInbox = join(testDir, 'inbox', 'boris');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      const content = JSON.parse(readFileSync(join(receiverInbox, files[0]), 'utf-8'));
      expect(content.text).toBe('tenant SSN [REDACTED-SSN] and [REDACTED-SSN] under ssn');
      expect(content.text).not.toContain('123-45-6789');
    });

    it('produces JSON matching bash format', () => {
      sendMessage(senderPaths, 'paul', 'boris', 'high', 'Build the page');

      const receiverInbox = join(testDir, 'inbox', 'boris');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      const content = JSON.parse(readFileSync(join(receiverInbox, files[0]), 'utf-8'));

      // Verify all fields match bash send-message.sh format
      expect(content).toHaveProperty('id');
      expect(content).toHaveProperty('from', 'paul');
      expect(content).toHaveProperty('to', 'boris');
      expect(content).toHaveProperty('priority', 'high');
      expect(content).toHaveProperty('timestamp');
      expect(content).toHaveProperty('text', 'Build the page');
      expect(content).toHaveProperty('reply_to', null);

      // Verify filename has priority 1 (high)
      expect(files[0]).toMatch(/^1-/);
    });

    it('encodes priority correctly in filename', () => {
      sendMessage(senderPaths, 'a', 'b', 'urgent', 'test');
      sendMessage(senderPaths, 'a', 'b', 'high', 'test');
      sendMessage(senderPaths, 'a', 'b', 'normal', 'test');
      sendMessage(senderPaths, 'a', 'b', 'low', 'test');

      const inbox = join(testDir, 'inbox', 'b');
      const files = readdirSync(inbox).filter(f => f.endsWith('.json')).sort();

      expect(files[0]).toMatch(/^0-/); // urgent
      expect(files[1]).toMatch(/^1-/); // high
      expect(files[2]).toMatch(/^2-/); // normal
      expect(files[3]).toMatch(/^3-/); // low
    });

    it('rejects invalid agent names', () => {
      expect(() =>
        sendMessage(senderPaths, '../bad', 'good', 'normal', 'test')
      ).toThrow();
    });
  });

  describe('checkInbox', () => {
    it('returns empty array for empty inbox', () => {
      const messages = checkInbox(receiverPaths);
      expect(messages).toEqual([]);
    });

    it('returns messages sorted by priority', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'low', 'low priority');
      sendMessage(senderPaths, 'sender', 'receiver', 'urgent', 'urgent');
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'normal');

      const messages = checkInbox(receiverPaths);
      expect(messages.length).toBe(3);
      expect(messages[0].priority).toBe('urgent');
      expect(messages[1].priority).toBe('normal');
      expect(messages[2].priority).toBe('low');
    });

    it('moves messages to inflight', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'test');
      checkInbox(receiverPaths);

      const inboxFiles = readdirSync(receiverPaths.inbox).filter(f => f.endsWith('.json'));
      const inflightFiles = readdirSync(receiverPaths.inflight).filter(f => f.endsWith('.json'));

      expect(inboxFiles.length).toBe(0);
      expect(inflightFiles.length).toBe(1);
    });

    it('throws a distinct failure instead of returning an empty inbox when the lock is unavailable', () => {
      mkdirSync(receiverPaths.inbox, { recursive: true });
      const lockHandle = acquireLock(receiverPaths.inbox);
      expect(lockHandle).not.toBe(false);

      expect(() => checkInbox(receiverPaths)).toThrow(InboxLockUnavailableError);

      if (!lockHandle) throw new Error('expected lock handle');
      expect(releaseLock(lockHandle)).toBe(true);
      expect(checkInbox(receiverPaths)).toEqual([]);
    });

    it('delivers queued messages after reaping a stale lock with no pid file', () => {
      const messageId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'no-pid recovery');
      const lockDir = join(receiverPaths.inbox, '.lock.d');
      mkdirSync(lockDir);
      const stale = new Date(Date.now() - 60_000);
      utimesSync(lockDir, stale, stale);

      expect(checkInbox(receiverPaths).map(message => message.id)).toEqual([messageId]);
    });

    it('delivers queued messages after reaping a stale lock with an empty pid file', () => {
      const messageId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'empty-pid recovery');
      const lockDir = join(receiverPaths.inbox, '.lock.d');
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'pid'), '');
      const stale = new Date(Date.now() - 60_000);
      utimesSync(lockDir, stale, stale);

      expect(checkInbox(receiverPaths).map(message => message.id)).toEqual([messageId]);
    });
  });

  describe('ackInbox', () => {
    it('moves message from inflight to processed', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'test');
      checkInbox(receiverPaths); // moves to inflight

      ackInbox(receiverPaths, msgId);

      const inflightFiles = readdirSync(receiverPaths.inflight).filter(f => f.endsWith('.json'));
      const processedFiles = readdirSync(receiverPaths.processed).filter(f => f.endsWith('.json'));

      expect(inflightFiles.length).toBe(0);
      expect(processedFiles.length).toBe(1);
    });
  });

  describe('pruneProcessed (F12)', () => {
    /** Create a .json file in a processed dir with an mtime `ageDays` in the past. */
    function plantProcessedFile(agent: string, name: string, ageDays: number): string {
      const dir = join(testDir, 'processed', agent);
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, name);
      writeFileSync(filePath, JSON.stringify({ id: name, text: 'x' }));
      const past = (Date.now() - ageDays * 24 * 60 * 60 * 1000) / 1000;
      utimesSync(filePath, past, past);
      return filePath;
    }

    it('deletes files older than the TTL and keeps recent files', () => {
      const oldFile = plantProcessedFile('receiver', '2-1-from-a-aaaaa.json', 45);
      const recentFile = plantProcessedFile('receiver', '2-2-from-a-bbbbb.json', 5);
      const todayFile = plantProcessedFile('receiver', '2-3-from-a-ccccc.json', 0);

      const result = pruneProcessed(receiverPaths, PROCESSED_TTL_DAYS);

      expect(existsSync(oldFile)).toBe(false);
      expect(existsSync(recentFile)).toBe(true);
      expect(existsSync(todayFile)).toBe(true);
      expect(result.deleted).toBe(1);
      expect(result.keptRecent).toBe(2);
      expect(result.scanned).toBe(3);
      expect(result.errors).toBe(0);
    });

    it('respects a custom TTL', () => {
      const tenDays = plantProcessedFile('receiver', '2-1-from-a-aaaaa.json', 10);
      const twoDays = plantProcessedFile('receiver', '2-2-from-a-bbbbb.json', 2);

      const result = pruneProcessed(receiverPaths, 7);

      expect(existsSync(tenDays)).toBe(false);
      expect(existsSync(twoDays)).toBe(true);
      expect(result.deleted).toBe(1);
    });

    it('rejects TTLs below the 1-day floor (never deletes recent files)', () => {
      plantProcessedFile('receiver', '2-1-from-a-aaaaa.json', 0.5);
      expect(() => pruneProcessed(receiverPaths, 0)).toThrow(/ttlDays/);
      expect(() => pruneProcessed(receiverPaths, -5)).toThrow(/ttlDays/);
      expect(() => pruneProcessed(receiverPaths, NaN)).toThrow(/ttlDays/);
    });

    it('returns zero counts when the processed dir does not exist', () => {
      const result = pruneProcessed(receiverPaths);
      expect(result).toEqual({ scanned: 0, deleted: 0, keptRecent: 0, errors: 0 });
    });

    it('only sweeps the calling agent by default; --all-agents sweeps every agent', () => {
      const mine = plantProcessedFile('receiver', '2-1-from-a-aaaaa.json', 45);
      const theirs = plantProcessedFile('other-agent', '2-2-from-b-bbbbb.json', 45);

      pruneProcessed(receiverPaths);
      expect(existsSync(mine)).toBe(false);
      expect(existsSync(theirs)).toBe(true); // untouched by per-agent sweep

      pruneProcessed(receiverPaths, PROCESSED_TTL_DAYS, { allAgents: true });
      expect(existsSync(theirs)).toBe(false);
    });

    it('ignores non-json files, dotfiles, and subdirectories even when old', () => {
      const dir = join(testDir, 'processed', 'receiver');
      mkdirSync(dir, { recursive: true });
      const past = (Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000;

      const txtFile = join(dir, 'notes.txt');
      writeFileSync(txtFile, 'keep me');
      utimesSync(txtFile, past, past);

      const dotFile = join(dir, '.hidden.json');
      writeFileSync(dotFile, '{}');
      utimesSync(dotFile, past, past);

      const subDir = join(dir, 'nested');
      mkdirSync(subDir);
      const nestedOld = join(subDir, 'old.json');
      writeFileSync(nestedOld, '{}');
      utimesSync(nestedOld, past, past);

      const result = pruneProcessed(receiverPaths);

      expect(existsSync(txtFile)).toBe(true);
      expect(existsSync(dotFile)).toBe(true);
      expect(existsSync(nestedOld)).toBe(true); // never recurses
      expect(result.deleted).toBe(0);
      expect(result.scanned).toBe(0);
    });

    it('refuses to sweep a processed path that escapes {ctxRoot}/processed/', () => {
      const outsideDir = join(testDir, 'inbox', 'victim');
      mkdirSync(outsideDir, { recursive: true });
      const victim = join(outsideDir, 'msg.json');
      writeFileSync(victim, '{}');
      const past = (Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000;
      utimesSync(victim, past, past);

      const evilPaths = { ...receiverPaths, processed: outsideDir };
      expect(() => pruneProcessed(evilPaths)).toThrow(/outside processed root/);
      expect(existsSync(victim)).toBe(true);

      // Traversal via .. inside the configured path is also rejected
      const traversal = { ...receiverPaths, processed: join(testDir, 'processed', 'receiver', '..', '..', 'inbox', 'victim') };
      expect(() => pruneProcessed(traversal)).toThrow(/outside processed root/);
      expect(existsSync(victim)).toBe(true);
    });

    it('does not follow symlinked agent dirs out of processed/ in --all-agents mode', () => {
      // A symlink inside processed/ pointing at an external dir full of old files
      const externalDir = join(testDir, 'external-data');
      mkdirSync(externalDir, { recursive: true });
      const externalFile = join(externalDir, 'precious.json');
      writeFileSync(externalFile, '{}');
      const past = (Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000;
      utimesSync(externalFile, past, past);

      mkdirSync(join(testDir, 'processed'), { recursive: true });
      symlinkSync(externalDir, join(testDir, 'processed', 'evil-link'));

      const result = pruneProcessed(receiverPaths, PROCESSED_TTL_DAYS, { allAgents: true });

      expect(existsSync(externalFile)).toBe(true); // symlinked dir was skipped
      expect(result.deleted).toBe(0);
    });

    it('end-to-end: ack then prune removes only aged acked messages', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'fresh');
      checkInbox(receiverPaths);
      ackInbox(receiverPaths, msgId);

      // Age one extra planted file past the TTL
      const aged = plantProcessedFile('receiver', '2-0-from-old-zzzzz.json', 60);

      const result = pruneProcessed(receiverPaths);

      expect(existsSync(aged)).toBe(false);
      const remaining = readdirSync(receiverPaths.processed).filter(f => f.endsWith('.json'));
      expect(remaining.length).toBe(1); // the just-acked message survives
      expect(result.deleted).toBe(1);
    });
  });
});
