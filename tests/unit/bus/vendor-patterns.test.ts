import { describe, expect, it } from 'vitest';
import {
  VENDOR_DOC_PATTERNS,
  listVendorDocPatterns,
  vendorDocPattern,
} from '../../../src/bus/vendor-patterns';

describe('vendor-patterns', () => {
  it('listVendorDocPatterns returns all 3 patterns', () => {
    expect(listVendorDocPatterns()).toEqual(VENDOR_DOC_PATTERNS);
    expect(listVendorDocPatterns()).toHaveLength(3);
  });

  it('looks up each vendor by exact canonical name', () => {
    expect(vendorDocPattern('Stubblefield')?.vendor_name).toBe('Stubblefield');
    expect(vendorDocPattern('ZJB')?.vendor_name).toBe('ZJB');
    expect(vendorDocPattern('Carlos')?.vendor_name).toBe('Carlos');
  });

  it('looks up aliases case-insensitively', () => {
    expect(vendorDocPattern('stubblefield plumbing')?.vendor_name).toBe('Stubblefield');
    expect(vendorDocPattern('ZjB SeRvIcEs')?.vendor_name).toBe('ZJB');
    expect(vendorDocPattern('carlos calel')?.vendor_name).toBe('Carlos');
  });

  it('returns null for an unknown vendor', () => {
    expect(vendorDocPattern('nonexistent vendor')).toBeNull();
  });

  it('returns null for null, undefined, and empty input', () => {
    expect(vendorDocPattern(null)).toBeNull();
    expect(vendorDocPattern(undefined)).toBeNull();
    expect(vendorDocPattern('')).toBeNull();
  });

  it('stores closeout_lag_minutes as a number for every pattern', () => {
    for (const pattern of VENDOR_DOC_PATTERNS) {
      expect(typeof pattern.closeout_lag_minutes).toBe('number');
    }
  });

  it('uses only valid DocSource members for photos and notes', () => {
    const validSources = new Set(['in-pm', 'off-system', 'late', 'manager-backfill']);

    for (const pattern of VENDOR_DOC_PATTERNS) {
      expect(validSources.has(pattern.photos)).toBe(true);
      expect(validSources.has(pattern.notes)).toBe(true);
    }
  });
});
