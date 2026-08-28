import { describe, expect, it, vi } from 'vitest';
import { IPCServer } from '../../../src/daemon/ipc-server.js';

function responseSocket() {
  let body = '';
  return {
    socket: {
      write: vi.fn((chunk: string) => { body += chunk; }),
      end: vi.fn(),
    },
    json: () => JSON.parse(body) as { success: boolean; error?: string },
  };
}

describe('worker IPC waits for the requested lifecycle outcome', () => {
  it('terminate-worker returns the revocation failure instead of an early success', async () => {
    const manager = {
      terminateWorker: vi.fn().mockRejectedValue(new Error('SESSION REVOCATION UNKNOWN for worker w1')),
    };
    const server = new IPCServer(manager as never, 'test');
    const out = responseSocket();

    await (server as never as {
      handleRequest(request: unknown, socket: unknown): Promise<void>;
    }).handleRequest({ type: 'terminate-worker', data: { name: 'w1' } }, out.socket);

    expect(manager.terminateWorker).toHaveBeenCalledWith('w1');
    expect(out.json()).toMatchObject({ success: false, error: expect.stringContaining('SESSION REVOCATION UNKNOWN') });
  });

  it('spawn-worker returns the tombstone refusal instead of an early success', async () => {
    const manager = {
      spawnWorker: vi.fn().mockRejectedValue(new Error('Worker "w1" cannot start: SESSION REVOCATION UNKNOWN')),
    };
    const server = new IPCServer(manager as never, 'test');
    const out = responseSocket();

    await (server as never as {
      handleRequest(request: unknown, socket: unknown): Promise<void>;
    }).handleRequest({
      type: 'spawn-worker',
      data: { name: 'w1', dir: process.cwd(), prompt: 'work' },
    }, out.socket);

    expect(manager.spawnWorker).toHaveBeenCalled();
    expect(out.json()).toMatchObject({ success: false, error: expect.stringContaining('SESSION REVOCATION UNKNOWN') });
  });
});
