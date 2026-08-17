import type { LockHandle } from '../../src/utils/lock';

declare const staleHandle: LockHandle;

// These are the exact identity members a caller used to rewrite a stale
// handle into a live successor. The opacity test compiles this fixture and
// requires every access to remain a property-not-found diagnostic.
staleHandle.lockDir;
staleHandle.generation.snapshot.dev = 1;
staleHandle.generation.snapshot.ino = 1;
staleHandle.generation.ownerToken = 'successor-owner-token';
