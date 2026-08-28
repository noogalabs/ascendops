/** Return a configured IANA timezone only when it is a non-empty string. */
export function configuredTimezone(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Resolve an explicit configured timezone, otherwise preserve host-local time. */
export function configuredOrHostTimezone(value: unknown): string {
  return configuredTimezone(value) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}
