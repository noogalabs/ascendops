export type DocSource = 'in-pm' | 'off-system' | 'late' | 'manager-backfill';

export interface VendorDocPattern {
  vendor_name: string;          // canonical name
  aliases: string[];             // matching aliases (case-insensitive)
  photos: DocSource;             // where photos land
  notes: DocSource;              // where notes land
  closeout_lag_minutes: number;  // how long after work completes do docs typically appear
  notes_text: string;            // short human-readable rule explanation
}

export const VENDOR_DOC_PATTERNS: VendorDocPattern[] = [
  {
    vendor_name: 'Stubblefield',
    aliases: ['stubblefield plumbing', 'stubblefield'],
    photos: 'off-system',
    notes: 'off-system',
    closeout_lag_minutes: 1440,
    notes_text: 'Full off-system. Photos and notes via text/email to manager, not PM. Verify by asking manager, not by PM doc check.',
  },
  {
    vendor_name: 'ZJB',
    aliases: ['zjb', 'zjb services'],
    photos: 'late',
    notes: 'manager-backfill',
    closeout_lag_minutes: 4320,
    notes_text: 'Late-upload pattern. Photos arrive in PM 1-3 days post-completion. Notes typically backfilled by manager from vendor verbal report.',
  },
  {
    vendor_name: 'Carlos',
    aliases: ['carlos', 'carlos calel'],
    photos: 'off-system',
    notes: 'off-system',
    closeout_lag_minutes: 0,
    notes_text: 'In-house tech, no-PM-logging pattern. Photos and notes typically skipped in PM; sweep and ask if doc-grade evidence required.',
  },
];

export function vendorDocPattern(vendorName: string | undefined | null): VendorDocPattern | null {
  if (!vendorName) return null;
  const target = vendorName.trim().toLowerCase();
  for (const p of VENDOR_DOC_PATTERNS) {
    if (p.vendor_name.toLowerCase() === target) return p;
    if (p.aliases.some(a => a.toLowerCase() === target)) return p;
  }
  return null;
}

export function listVendorDocPatterns(): VendorDocPattern[] {
  return [...VENDOR_DOC_PATTERNS];
}
