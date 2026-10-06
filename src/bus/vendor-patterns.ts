import { readFileSync } from 'fs';

export type DocSource = 'in-pm' | 'off-system' | 'late' | 'manager-backfill';

export interface VendorDocPattern {
  vendor_name: string;          // canonical name
  aliases: string[];             // matching aliases (case-insensitive)
  photos: DocSource;             // where photos land
  notes: DocSource;              // where notes land
  closeout_lag_minutes: number;  // how long after work completes do docs typically appear
  notes_text: string;            // short human-readable rule explanation
}

// Member-specific patterns belong in the selected organization's configuration.
// The public distribution ships no vendor identities or documentation assumptions.
export const VENDOR_DOC_PATTERNS: VendorDocPattern[] = [];

export function listVendorDocPatterns(configPath?: string): VendorDocPattern[] {
  if (!configPath) return [];
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows: unknown = JSON.parse(raw);
  const sources = new Set(['in-pm', 'off-system', 'late', 'manager-backfill']);
  const names = new Set<string>();
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  if (!Array.isArray(rows)) throw new Error('Vendor doc configuration must be an array');
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !text(row.vendor_name)
      || !Array.isArray(row.aliases) || !row.aliases.every(text)
      || !sources.has(row.photos) || !sources.has(row.notes)
      || !Number.isSafeInteger(row.closeout_lag_minutes) || row.closeout_lag_minutes < 0
      || typeof row.notes_text !== 'string') {
      throw new Error('Invalid vendor doc configuration row');
    }
    // An alias matching its own canonical name is harmless; cross-row ambiguity is not.
    const keys = new Set<string>([row.vendor_name, ...row.aliases].map((name: string) => name.trim().toLowerCase()));
    for (const key of keys) {
      if (names.has(key)) throw new Error('Ambiguous vendor doc configuration name');
      names.add(key);
    }
  }
  return rows as VendorDocPattern[];
}

export function vendorDocPattern(vendorName: string | undefined | null, configPath?: string): VendorDocPattern | null {
  if (!vendorName) return null;
  const target = vendorName.trim().toLowerCase();
  return listVendorDocPatterns(configPath).find(pattern =>
    [pattern.vendor_name, ...pattern.aliases].some(name => name.trim().toLowerCase() === target)
  ) ?? null;
}
