import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import {
  readNativePeerCredentials,
  readNativeProcessIdentity,
  runNativeFullFsync,
} from '../../../src/daemon/native-peer-credential-helper';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('native peer credential helper', () => {
  it('skips the POSIX helper build on win32 without invoking cc', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-peer-helper-win32-'));
    tempDirs.push(dir);
    const binary = join(dir, 'win32-peer-credentials');
    const build = spawnSync(process.execPath, ['scripts/build-peer-credential-helper.mjs', binary], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, CORTEXTOS_BUILD_PLATFORM: 'win32', CC: 'definitely-missing-compiler' },
    });
    expect(build.status, build.stderr).toBe(0);
    expect(build.stdout).toContain('custody/reaper remain disabled');
    expect(existsSync(binary)).toBe(false);
  });
  it('measures the connected Unix peer rather than trusting request fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-peer-helper-'));
    tempDirs.push(dir);
    const binary = join(dir, 'peer-credentials');
    const build = spawnSync(process.execPath, ['scripts/build-peer-credential-helper.mjs', binary], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(build.status, build.stderr).toBe(0);

    const socketPath = join(dir, 'peer.sock');
    const measured = await new Promise<Awaited<ReturnType<typeof readNativePeerCredentials>>>((resolve, reject) => {
      const server = net.createServer(async socket => {
        try {
          const fd = (socket as net.Socket & { _handle?: { fd?: number } })._handle?.fd;
          expect(fd).toBeTypeOf('number');
          resolve(await readNativePeerCredentials(fd!, binary));
        } catch (error) {
          reject(error);
        } finally {
          socket.destroy();
          server.close();
        }
      });
      server.once('error', reject);
      server.listen(socketPath, () => {
        const client = net.createConnection(socketPath);
        client.once('error', reject);
      });
    });

    expect(measured.pid).toBe(process.pid);
    expect(measured.platform).toBe(process.platform === 'darwin' ? 'darwin' : 'linux');
    expect(measured.processStartIdentity).toMatch(/\S/);
  });

  it.skipIf(process.platform !== 'darwin')('executes macOS F_FULLFSYNC through the native helper', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-peer-helper-'));
    tempDirs.push(dir);
    const binary = join(dir, 'peer-credentials');
    const build = spawnSync(process.execPath, ['scripts/build-peer-credential-helper.mjs', binary], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(build.status, build.stderr).toBe(0);
    const target = join(dir, 'durable.json');
    writeFileSync(target, '{}\n');
    expect(() => runNativeFullFsync(target, binary)).not.toThrow();
  });

  it('reads the current process high-resolution kernel identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-peer-helper-'));
    tempDirs.push(dir);
    const binary = join(dir, 'peer-credentials');
    const build = spawnSync(process.execPath, ['scripts/build-peer-credential-helper.mjs', binary], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(build.status, build.stderr).toBe(0);
    const identity = readNativeProcessIdentity(process.pid, binary);
    expect(identity.kind).toBe('known');
    if (identity.kind === 'known') expect(identity.kernelToken).toMatch(/\S/);
  });
});
