import { afterEach, describe, expect, it } from 'vitest';
import {
  configuredOrHostTimezone,
  configuredTimezone,
} from '../../../src/utils/timezone.js';

const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('timezone coercion policy', () => {
  it('NAMED TZ RESOLVER BLANK: missing and empty values do not become literals', () => {
    expect(configuredTimezone(undefined)).toBeUndefined();
    expect(configuredTimezone('')).toBeUndefined();
    expect(configuredTimezone(false)).toBeUndefined();
  });

  it('NAMED TZ RESOLVER EXPLICIT: configured IANA value is preserved', () => {
    expect(configuredTimezone('America/New_York')).toBe('America/New_York');
  });

  it('NAMED TZ RESOLVER HOST: blank value resolves to daemon host timezone', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(configuredOrHostTimezone('')).toBe('America/Los_Angeles');
  });
});
