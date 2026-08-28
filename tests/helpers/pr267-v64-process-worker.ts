import { existsSync, writeFileSync } from 'node:fs';
import { createWorktreeLeaseRuntime } from '../../src/daemon/worktree-lease-runtime';
import { acceptNativeMeasuredPeer } from '../../src/daemon/peer-credentials';

const [operation, commonDir, ctxRoot, scopeKey, requestId, token, holderPidText,
  readyPath, goPath, resultPath] = process.argv.slice(2);

if (!operation || !commonDir || !ctxRoot || !scopeKey || !requestId || !token
  || !holderPidText || !readyPath || !goPath || !resultPath) {
  throw new Error('missing worker arguments');
}

const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
const holderPid = Number(holderPidText);
const identity = (pid: number) => ({
  kind: 'known' as const,
  pid,
  platform,
  kernelToken: `kernel:${pid}`,
});
const runtime = createWorktreeLeaseRuntime({
  ctxRoot,
  repositoryCommonDir: commonDir,
  nativeHelperPath: '/usr/bin/true',
  readProcessIdentity: identity,
});
const peer = acceptNativeMeasuredPeer({
  pid: holderPid,
  platform,
  processStartIdentity: `kernel:${holderPid}`,
});
const wait = new Int32Array(new SharedArrayBuffer(4));
const barrier = () => {
  writeFileSync(readyPath, `${process.pid}\n`);
  const deadline = Date.now() + 10_000;
  while (!existsSync(goPath)) {
    if (Date.now() > deadline) throw new Error('barrier timeout');
    Atomics.wait(wait, 0, 0, 10);
  }
};

if (operation === 'bind-held') {
  const publish = runtime.store.publish.bind(runtime.store);
  runtime.store.publish = record => {
    if (record.destructiveChild) barrier();
    publish(record);
  };
} else if (operation === 'release-held') {
  const remove = runtime.store.remove.bind(runtime.store);
  runtime.store.remove = record => {
    barrier();
    remove(record);
  };
}

const result = operation.startsWith('bind')
  ? runtime.arbiter.bindDestructiveChild(scopeKey, requestId, token, peer, {
      pid: holderPid,
      platform,
      processStartIdentity: `kernel:${holderPid}`,
    })
  : runtime.arbiter.release(scopeKey, requestId, token);

writeFileSync(resultPath, `${JSON.stringify(result)}\n`);
