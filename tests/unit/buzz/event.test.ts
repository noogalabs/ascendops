import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildEvent,
  buildAuthEvent,
  buildChannelMessageEvent,
  computeEventId,
  verifyEvent,
  getPublicKey,
} from '../../../src/buzz/event';
import { schnorr } from '@noble/secp256k1';
import { hexToBytes } from '@noble/hashes/utils.js';

// BIP-340 official test vector 0. Identity generation is deliberately outside
// the production adapter: tests consume fixed externally supplied vectors.
const SECRET_KEY = '0000000000000000000000000000000000000000000000000000000000000003';
const PUBLIC_KEY = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';
const VECTOR_MESSAGE = '0000000000000000000000000000000000000000000000000000000000000000';
const VECTOR_SIGNATURE = 'e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0';

describe('external BIP-340 known-answer vector', () => {
  it('derives the official vector public key and verifies its signature', () => {
    expect(getPublicKey(SECRET_KEY)).toBe(PUBLIC_KEY);
    expect(schnorr.verify(
      hexToBytes(VECTOR_SIGNATURE),
      hexToBytes(VECTOR_MESSAGE),
      hexToBytes(PUBLIC_KEY),
    )).toBe(true);
  });
});

describe('identity minting boundary', () => {
  it('has no production random-key or keypair-minting API', () => {
    const production = [
      readFileSync(join(process.cwd(), 'src/buzz/event.ts'), 'utf8'),
      readFileSync(join(process.cwd(), 'src/buzz/index.ts'), 'utf8'),
    ].join('\n');
    expect(production).not.toMatch(/randomSecretKey|generateKeypair/);
  });
});

describe('buildEvent', () => {
  const secretKey = SECRET_KEY;
  const pubkey = PUBLIC_KEY;

  it('signs with the correct pubkey derived from the secret key', () => {
    const event = buildEvent(9, 'hello', [['h', 'chan-1']], secretKey);
    expect(event.pubkey).toBe(pubkey);
  });

  it('computes an id matching computeEventId over the same fields', () => {
    const event = buildEvent(9, 'hello', [['h', 'chan-1']], secretKey);
    const recomputed = computeEventId({
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
    });
    expect(event.id).toBe(recomputed);
  });

  it('produces a signature that verifies successfully', () => {
    const event = buildEvent(9, 'hello', [], secretKey);
    expect(verifyEvent(event)).toBe(true);
  });

  it('two events with different content have different ids', () => {
    const a = buildEvent(9, 'hello', [], secretKey);
    const b = buildEvent(9, 'goodbye', [], secretKey);
    expect(a.id).not.toBe(b.id);
  });
});

describe('buildAuthEvent', () => {
  const secretKey = SECRET_KEY;

  it('is kind 22242 with empty content', () => {
    const event = buildAuthEvent('challenge-abc', 'wss://relay.example.com', secretKey);
    expect(event.kind).toBe(22242);
    expect(event.content).toBe('');
  });

  it('carries relay and challenge tags', () => {
    const event = buildAuthEvent('challenge-abc', 'wss://relay.example.com', secretKey);
    expect(event.tags).toContainEqual(['relay', 'wss://relay.example.com']);
    expect(event.tags).toContainEqual(['challenge', 'challenge-abc']);
  });

  it('verifies successfully', () => {
    const event = buildAuthEvent('challenge-abc', 'wss://relay.example.com', secretKey);
    expect(verifyEvent(event)).toBe(true);
  });
});

describe('buildChannelMessageEvent', () => {
  const secretKey = SECRET_KEY;

  it('is kind 9 with an #h channel tag (relay requires this for channel scoping)', () => {
    const event = buildChannelMessageEvent('chan-uuid-1', 'hello channel', secretKey);
    expect(event.kind).toBe(9);
    expect(event.tags).toContainEqual(['h', 'chan-uuid-1']);
    expect(event.content).toBe('hello channel');
  });

  it('omits the reply tag when replyToEventId is not provided', () => {
    const event = buildChannelMessageEvent('chan-uuid-1', 'hi', secretKey);
    expect(event.tags.some((t) => t[0] === 'e')).toBe(false);
  });

  it('adds a NIP-10 reply tag when replyToEventId is provided', () => {
    const event = buildChannelMessageEvent('chan-uuid-1', 'hi', secretKey, 'parent-event-id');
    expect(event.tags).toContainEqual(['e', 'parent-event-id', '', 'reply']);
  });
});

describe('verifyEvent', () => {
  const secretKey = SECRET_KEY;

  it('returns false when the signature does not match a tampered id', () => {
    const event = buildEvent(9, 'hello', [], secretKey);
    const tampered = { ...event, id: 'a'.repeat(64) };
    expect(verifyEvent(tampered)).toBe(false);
  });

  it('returns false when content is tampered after signing (id mismatch)', () => {
    const event = buildEvent(9, 'hello', [], secretKey);
    const tampered = { ...event, content: 'tampered content' };
    expect(verifyEvent(tampered)).toBe(false);
  });

  it('returns false on malformed hex fields rather than throwing', () => {
    const event = buildEvent(9, 'hello', [], secretKey);
    const malformed = { ...event, sig: 'not-hex!!' };
    expect(() => verifyEvent(malformed)).not.toThrow();
    expect(verifyEvent(malformed)).toBe(false);
  });
});
