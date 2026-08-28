import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createServer, connect, type Server } from 'net';

/**
 * A process that never bound the socket must not unlink it.
 *
 * The abort path added for duplicate-daemon rejection throws, the throw reaches
 * `process.exit(1)`, and the already-registered exit handler calls
 * `ipcServer.stop()`. `stop()` unlinked the socket unconditionally — so the
 * duplicate deleted the ORIGINAL daemon's socket on its way out and left it
 * running but unreachable by every CLI. **Worse than the defect the abort closed.**
 *
 * Deleting a resource you never acquired is not cleanup.
 */
describe('IPC socket ownership on stop', () => {
  let original: Server | null = null;
  let dir = '';
  afterEach(async () => {
    if (original) await new Promise<void>(r => original!.close(() => r()));
    original = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a duplicate that never bound leaves the original socket alive and answering', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ipc-own-'));
    const socketPath = join(dir, 'daemon.sock');

    // The ORIGINAL daemon owns the socket.
    original = createServer(() => {});
    await new Promise<void>(r => original!.listen(socketPath, r));
    expect(existsSync(socketPath)).toBe(true);

    // A DUPLICATE constructs its server, never binds, and is torn down.
    const { IPCServer } = await import('../../../src/daemon/ipc-server');
    const duplicate = new IPCServer({} as never, 'test');
    (duplicate as unknown as { socketPath: string }).socketPath = socketPath;
    duplicate.stop();

    // The original's socket must still exist AND still answer.
    expect(existsSync(socketPath)).toBe(true);
    const answered = await new Promise<boolean>(resolve => {
      const c = connect(socketPath);
      c.once('connect', () => { c.destroy(); resolve(true); });
      c.once('error', () => resolve(false));
      c.setTimeout(500, () => { c.destroy(); resolve(false); });
    });
    expect(answered).toBe(true);
  });
});
