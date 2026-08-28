import { describe, it, expect } from 'vitest';
import { bindInstanceAndReconcileSessionRecords } from '../../../src/daemon/instance-boot-sequence';

/**
 * probe -> bind -> revoke, proven by WHAT RAN.
 *
 * Every textual version of this check was defeated. The first searched the whole
 * file and a comment satisfied it. The second scoped the search to the function
 * body — and a decoy comment INSIDE the body satisfied that too, with the real
 * call aliased through a `const` so it moved without the text moving. Scoping
 * shrinks the places a decoy reads naturally; it does not remove the class.
 *
 * The order is now read off an array the collaborators push into. A decoy comment
 * pushes nothing. An aliased call still pushes, and pushes where it actually runs.
 */
describe('instance boot sequence', () => {
  it('runs probe, then bind, then revoke', async () => {
    const order: string[] = [];
    await bindInstanceAndReconcileSessionRecords({
      probe: async () => { order.push('probe'); return false; },
      bind: async () => { order.push('bind'); },
      revoke: () => { order.push('revoke'); },
    });
    expect(order).toEqual(['probe', 'bind', 'revoke']);
  });

  it('aborts on conflict and NEVER binds', async () => {
    const order: string[] = [];
    await expect(bindInstanceAndReconcileSessionRecords({
      probe: async () => { order.push('probe'); return true; },
      bind: async () => { order.push('bind'); },
      revoke: () => { order.push('revoke'); },
      onConflict: () => order.push('conflict'),
    })).rejects.toThrow('another daemon is already running for this instance');
    // `bind` must never appear: aborting after binding would steal the socket,
    // and `revoke` must never appear: that would wipe the live daemon's records.
    expect(order).toEqual(['probe', 'conflict']);
  });

  it('does not revoke when the bind itself fails', async () => {
    const order: string[] = [];
    await expect(bindInstanceAndReconcileSessionRecords({
      probe: async () => { order.push('probe'); return false; },
      bind: async () => { order.push('bind'); throw new Error('port in use'); },
      revoke: () => { order.push('revoke'); },
    })).rejects.toThrow('port in use');
    expect(order).toEqual(['probe', 'bind']);
  });
});
