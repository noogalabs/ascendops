import { describe, it, expect } from 'vitest';
import {
  pickUserFromUpdates,
  pollForUser,
  type UpdatePoller,
} from '../../../src/cli/detect-chat-id.js';

describe('detect-chat-id: pickUserFromUpdates', () => {
  it('returns null when getUpdates result is empty', () => {
    expect(pickUserFromUpdates({ ok: true, result: [] })).toBeNull();
    expect(pickUserFromUpdates({ ok: true })).toBeNull();
    expect(pickUserFromUpdates(null)).toBeNull();
  });

  it('captures chat_id + allowed_user from a /start message', () => {
    const updates = {
      ok: true,
      result: [
        {
          update_id: 1,
          message: {
            chat: { id: 555111222 },
            from: { id: 555111222, username: 'operator', first_name: 'Brett', is_bot: false },
            text: '/start',
          },
        },
      ],
    };
    const user = pickUserFromUpdates(updates);
    expect(user).not.toBeNull();
    expect(user!.chatId).toBe(555111222);
    expect(user!.username).toBe('operator');
    expect(user!.firstName).toBe('Brett');
  });

  it('prefers the most recent /start over an earlier plain message', () => {
    const updates = {
      ok: true,
      result: [
        { update_id: 1, message: { chat: { id: 111 }, from: { id: 111, is_bot: false }, text: 'hi' } },
        { update_id: 2, message: { chat: { id: 222 }, from: { id: 222, username: 'real', is_bot: false }, text: '/start' } },
      ],
    };
    const user = pickUserFromUpdates(updates);
    expect(user!.chatId).toBe(222);
    expect(user!.username).toBe('real');
  });

  it('falls back to the most recent plain message when no /start is present', () => {
    const updates = {
      ok: true,
      result: [
        { update_id: 1, message: { chat: { id: 111 }, from: { id: 111, is_bot: false }, text: 'first' } },
        { update_id: 2, message: { chat: { id: 333 }, from: { id: 333, is_bot: false }, text: 'second' } },
      ],
    };
    expect(pickUserFromUpdates(updates)!.chatId).toBe(333);
  });

  it('ignores bot-authored messages', () => {
    const updates = {
      ok: true,
      result: [
        { update_id: 1, message: { chat: { id: 999 }, from: { id: 999, is_bot: true }, text: '/start' } },
      ],
    };
    expect(pickUserFromUpdates(updates)).toBeNull();
  });

  it('falls back to from.id when username is absent', () => {
    const updates = {
      ok: true,
      result: [
        { update_id: 1, message: { chat: { id: 42 }, from: { id: 42, first_name: 'NoUser', is_bot: false }, text: '/start' } },
      ],
    };
    const user = pickUserFromUpdates(updates)!;
    expect(user.chatId).toBe(42);
    expect(user.username).toBeUndefined();
    expect(user.fromId).toBe(42);
  });
});

describe('detect-chat-id: pollForUser (bounded loop)', () => {
  it('returns immediately when a user message is already present', async () => {
    const api: UpdatePoller = {
      getUpdates: async () => ({
        ok: true,
        result: [{ message: { chat: { id: 7 }, from: { id: 7, is_bot: false }, text: '/start' } }],
      }),
    };
    const { user, lastError } = await pollForUser(api, 10, 1);
    expect(user).not.toBeNull();
    expect(user!.chatId).toBe(7);
    expect(lastError).toBeNull();
  });

  it('times out gracefully (returns null) when no message ever arrives', async () => {
    let calls = 0;
    const api: UpdatePoller = {
      getUpdates: async () => {
        calls++;
        return { ok: true, result: [] };
      },
    };
    const start = Date.now();
    const { user } = await pollForUser(api, 2, 1);
    const elapsed = Date.now() - start;
    expect(user).toBeNull();
    expect(calls).toBeGreaterThanOrEqual(1);
    // Bounded: must not run wildly past the 2s deadline.
    expect(elapsed).toBeLessThan(6000);
  });

  it('captures the user once a message arrives mid-poll', async () => {
    let calls = 0;
    const api: UpdatePoller = {
      getUpdates: async () => {
        calls++;
        if (calls < 2) return { ok: true, result: [] };
        return { ok: true, result: [{ message: { chat: { id: 88 }, from: { id: 88, is_bot: false }, text: '/start' } }] };
      },
    };
    const { user } = await pollForUser(api, 10, 1);
    expect(user!.chatId).toBe(88);
  });

  it('bails immediately on an Unauthorized (expired/revoked token) error', async () => {
    let calls = 0;
    const api: UpdatePoller = {
      getUpdates: async () => {
        calls++;
        throw new Error('Telegram API error: Unauthorized');
      },
    };
    const { user, lastError } = await pollForUser(api, 30, 1);
    expect(user).toBeNull();
    expect(lastError).toMatch(/unauthorized/i);
    // Must not keep retrying a token that will never succeed.
    expect(calls).toBe(1);
  });

  it('tolerates transient network errors and keeps polling until a message lands', async () => {
    let calls = 0;
    const api: UpdatePoller = {
      getUpdates: async () => {
        calls++;
        if (calls === 1) throw new Error('Telegram API request timed out after 15s: getUpdates');
        return { ok: true, result: [{ message: { chat: { id: 5 }, from: { id: 5, is_bot: false }, text: '/start' } }] };
      },
    };
    const { user } = await pollForUser(api, 10, 1);
    expect(user!.chatId).toBe(5);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
