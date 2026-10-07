import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { VENDOR_DOC_PATTERNS, listVendorDocPatterns, vendorDocPattern } from '../../../src/bus/vendor-patterns';

describe('member-configured vendor patterns', () => {
  let root: string;
  let config: string;
  const fixture = { vendor_name: 'Example Plumbing', aliases: ['example plumber'], photos: 'off-system', notes: 'manager-backfill', closeout_lag_minutes: 60, notes_text: 'Synthetic documentation rule' };
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'vendor-patterns-')); config = join(root, 'vendor-doc-patterns.json'); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const save = (value: unknown) => writeFileSync(config, JSON.stringify(value));

  it('ships no member identities or inferred vendor rules', () => {
    expect(VENDOR_DOC_PATTERNS).toEqual([]);
    expect(listVendorDocPatterns()).toEqual([]);
    expect(listVendorDocPatterns(config)).toEqual([]);
    expect(vendorDocPattern('Example Plumbing')).toBeNull();
  });
  it('loads canonical names and aliases only from the selected configuration', () => {
    save([fixture]);
    expect(listVendorDocPatterns(config)).toEqual([fixture]);
    expect(vendorDocPattern(' EXAMPLE PLUMBER ', config)).toEqual(fixture);
    expect(vendorDocPattern('example plumbing', config)).toEqual(fixture);
    expect(vendorDocPattern('unknown', config)).toBeNull();
    for (const input of [null, undefined, '']) expect(vendorDocPattern(input, config)).toBeNull();
  });
  it('the public CLI consumes the explicitly selected member configuration', () => {
    save([fixture]);
    const output = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli/index.ts', 'bus', 'vendor-patterns', 'list', '--format', 'json', '--config', config], { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual([fixture]);
  });
  it('does not carry patterns between organization files or caller mutations', () => {
    save([fixture]);
    listVendorDocPatterns(config)[0].aliases.push('mutated');
    expect(vendorDocPattern('mutated', config)).toBeNull();
    const other = join(root, 'another-org.json');
    writeFileSync(other, '[]');
    expect(vendorDocPattern('Example Plumbing', other)).toBeNull();
    expect(vendorDocPattern('Example Plumbing', config)).toEqual(fixture);
  });
  it('refuses malformed, mistyped and ambiguous configuration instead of using defaults', () => {
    for (const value of [{}, [null], [{ ...fixture, photos: 'unknown' }], [{ ...fixture, aliases: [42] }], [{ ...fixture, closeout_lag_minutes: -1 }], [{ ...fixture, closeout_lag_minutes: 1.5 }], [fixture, { ...fixture, vendor_name: 'Other', aliases: ['EXAMPLE PLUMBER'] }]]) {
      save(value);
      expect(() => listVendorDocPatterns(config)).toThrow();
    }
    writeFileSync(config, '{broken');
    expect(() => listVendorDocPatterns(config)).toThrow();
    expect(() => listVendorDocPatterns(root)).toThrow();
  });
});
