import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { atomicWriteSync } from '../utils/atomic.js';
import {
  rl,
  ask,
  askRequired,
  askDefault,
  askYN,
  askChoice,
  askMultiChoice,
  askMasked,
  askMultiline,
} from './_prompt-helpers.js';

const VERSION = 1;
const PROFILE_FILENAME = 'business-profile.json';
const SECRETS_FILENAME = 'secrets.env';

const PM_SOFTWARE_OPTIONS = [
  'Property Meld',
  'AppFolio',
  'Buildium',
  'Rentvine',
  'Rent Manager',
  'Other',
  'None',
];
const LEASING_TOOLS_OPTIONS = [
  'Zillow Rental Manager',
  'Apartments.com',
  'RentCafe',
  'Showdigs',
  'Tenant Turner',
  'Other',
  'None',
];

const PROJECT_TRACKING_OPTIONS = [
  'Asana',
  'Trello',
  'Notion',
  'ClickUp',
  'Linear',
  'Monday',
  'Other',
  'None',
];

const ACCOUNTING_OPTIONS = [
  'QuickBooks Online',
  'Xero',
  'AppFolio',
  'Buildium',
  'Other',
  'None',
];

const STYLE_TAG_OPTIONS = [
  'warm-professional',
  'direct',
  'casual',
  'formal',
  'industry-specific',
];

const SECTION_PICK_OPTIONS = [
  'Company identity',
  'Tech stack',
  'Gemini API key',
  'Day-mode hours',
  'Comms tone',
  'Run everything (replace whole profile)',
];

interface CompanySection {
  legal_name: string;
  dba?: string;
  primary_city: string;
  primary_state: string;
  door_count: number;
}

interface TechStackSection {
  pm_software: string;
  pm_software_other?: string;
  leasing_tools: string[];
  leasing_tools_other?: string;
  project_tracking: string[];
  project_tracking_other?: string;
  accounting: string;
  accounting_other?: string;
  other_tools: Array<{ name: string; description: string }>;
}

interface HoursSection {
  day_mode_start: string;
  day_mode_end: string;
  timezone: string;
  emergency_definition: string;
}

interface CommsToneSection {
  style_tags: string[];
  voice_sample: string;
}

interface BusinessProfile {
  version: number;
  completed_at: string;
  company: CompanySection;
  tech_stack: TechStackSection;
  hours: HoursSection;
  comms_tone: CommsToneSection;
}

export const configureCommand = new Command('configure')
  .option('--org <org>', 'Organization name (auto-detected if a single org exists)')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Configure your business profile — company, tech stack, PM creds, hours, comms tone')
  .action(async (options: { org?: string; instance: string }) => {
    const projectRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd();
    const org = resolveOrg(projectRoot, options.org);
    if (!org) {
      console.error('Could not detect org. Pass --org <name> or run `cortextos init <org>` first.');
      process.exit(1);
    }

    const orgDir = join(projectRoot, 'orgs', org);
    if (!existsSync(orgDir)) {
      console.error(`Org directory not found at ${orgDir}. Run \`cortextos init ${org}\` first.`);
      process.exit(1);
    }

    const agentNames = readAgentNames(orgDir);
    if (agentNames.length === 0) {
      console.error(`No agents found under ${orgDir}/agents/. Run \`cortextos add-agent <name> --template <template> --org ${org}\` first.`);
      process.exit(1);
    }

    const profilePath = join(orgDir, PROFILE_FILENAME);
    const existing = readExistingProfile(profilePath);

    console.log('\n  AscendOps business profile configuration\n');
    console.log(`  Org:    ${org}`);
    console.log(`  Agents: ${agentNames.join(', ')}`);
    console.log('');

    const iface = rl();

    try {
      let next: BusinessProfile;
      if (existing) {
        next = await runSectionPickFlow(iface, existing, org, projectRoot);
      } else {
        next = await runFullFlow(iface, org, projectRoot);
      }

      next.completed_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      printReviewSummary(next);
      const confirm = await askYN(iface, '  Save profile?', true);
      if (!confirm) {
        console.log('\n  Skipped saving. Re-run `cortextos configure` to retry.');
        iface.close();
        return;
      }

      atomicWriteSync(profilePath, JSON.stringify(next, null, 2) + '\n');
      try {
        const { chmodSync } = await import('fs');
        chmodSync(profilePath, 0o600);
      } catch { /* best effort */ }

      console.log(`\n  ✓ Saved profile to ${profilePath}`);
      console.log(`\n  Next: restart your persona agents to pick up the new context:`);
      for (const agent of agentNames) {
        console.log(`    cortextos restart ${agent}`);
      }
      console.log('');
    } finally {
      iface.close();
    }
  });

function resolveOrg(projectRoot: string, explicit?: string): string | null {
  if (explicit) return explicit;
  const orgsDir = join(projectRoot, 'orgs');
  if (!existsSync(orgsDir)) return null;
  try {
    const orgs = readdirSync(orgsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    return orgs.length === 1 ? orgs[0] : null;
  } catch {
    return null;
  }
}

function readAgentNames(orgDir: string): string[] {
  const agentsDir = join(orgDir, 'agents');
  if (!existsSync(agentsDir)) return [];
  try {
    return readdirSync(agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  } catch {
    return [];
  }
}

function readExistingProfile(path: string): BusinessProfile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as BusinessProfile;
    if (typeof raw === 'object' && raw && raw.version === VERSION) return raw;
    return null;
  } catch {
    return null;
  }
}

async function runFullFlow(
  iface: import('readline').Interface,
  org: string,
  projectRoot: string,
): Promise<BusinessProfile> {
  const company = await screenCompany(iface);
  const tech_stack = await screenTechStack(iface);
  await screenGeminiKey(iface, org, projectRoot);
  const hours = await screenHours(iface);
  const comms_tone = await screenCommsTone(iface);
  printTirithReminder();
  return { version: VERSION, completed_at: '', company, tech_stack, hours, comms_tone };
}

async function runSectionPickFlow(
  iface: import('readline').Interface,
  existing: BusinessProfile,
  org: string,
  projectRoot: string,
): Promise<BusinessProfile> {
  console.log('  A profile already exists for this org.\n');
  const pick = await askChoice(iface, 'What do you want to update?', SECTION_PICK_OPTIONS);

  const next: BusinessProfile = JSON.parse(JSON.stringify(existing));
  switch (pick) {
    case 'Company identity':
      next.company = await screenCompany(iface);
      break;
    case 'Tech stack':
      next.tech_stack = await screenTechStack(iface);
      break;
    case 'Gemini API key':
      await screenGeminiKey(iface, org, projectRoot);
      break;
    case 'Day-mode hours':
      next.hours = await screenHours(iface);
      break;
    case 'Comms tone':
      next.comms_tone = await screenCommsTone(iface);
      break;
    case 'Run everything (replace whole profile)':
      return runFullFlow(iface, org, projectRoot);
  }
  return next;
}

async function screenCompany(iface: import('readline').Interface): Promise<CompanySection> {
  console.log('\n  ── Company identity ──\n');
  const legal_name = await askRequired(iface, '  Legal name: ', 'Legal name is required.');
  const dbaRaw = await ask(iface, '  DBA (leave blank if same as legal name): ');
  const primary_city = await askRequired(iface, '  Primary city: ', 'City is required.');
  const primary_state = await askRequired(iface, '  Primary state (2-letter or full): ', 'State is required.');
  let door_count = 0;
  while (true) {
    const raw = await askRequired(iface, '  Door count (integer): ', 'Door count is required.');
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0) { door_count = n; break; }
    console.log('  Enter a positive integer.');
  }
  return { legal_name, ...(dbaRaw ? { dba: dbaRaw } : {}), primary_city, primary_state, door_count };
}

async function screenTechStack(iface: import('readline').Interface): Promise<TechStackSection> {
  console.log('\n  ── Tech stack discovery ──\n');
  console.log('  Captured for AscendOps integration-roadmap visibility regardless of what you pick.');

  const pm = await askChoice(iface, 'PM software:', PM_SOFTWARE_OPTIONS);
  const pmOther = pm === 'Other' ? await askRequired(iface, '  Which PM software? ', 'Required.') : undefined;

  const leasing = await askMultiChoice(iface, 'Leasing tools (multi-select):', LEASING_TOOLS_OPTIONS);
  const leasingOther = leasing.includes('Other')
    ? await askRequired(iface, '  Which leasing tool(s)? ', 'Required.')
    : undefined;

  const project = await askMultiChoice(iface, 'Project tracking (multi-select):', PROJECT_TRACKING_OPTIONS);
  const projectOther = project.includes('Other')
    ? await askRequired(iface, '  Which project-tracking tool(s)? ', 'Required.')
    : undefined;

  const accounting = await askChoice(iface, 'Accounting:', ACCOUNTING_OPTIONS);
  const accountingOther = accounting === 'Other'
    ? await askRequired(iface, '  Which accounting tool? ', 'Required.')
    : undefined;

  const other_tools: Array<{ name: string; description: string }> = [];
  while (await askYN(iface, '  Add another tool not listed above?', false)) {
    const name = await askRequired(iface, '    Tool name: ', 'Name required.');
    const description = await ask(iface, '    Brief description (1 line): ');
    other_tools.push({ name, description });
  }

  return {
    pm_software: pm,
    ...(pmOther ? { pm_software_other: pmOther } : {}),
    leasing_tools: leasing,
    ...(leasingOther ? { leasing_tools_other: leasingOther } : {}),
    project_tracking: project,
    ...(projectOther ? { project_tracking_other: projectOther } : {}),
    accounting,
    ...(accountingOther ? { accounting_other: accountingOther } : {}),
    other_tools,
  };
}

async function screenGeminiKey(
  iface: import('readline').Interface,
  org: string,
  projectRoot: string,
): Promise<void> {
  console.log('\n  ── Knowledge base embeddings — required ──\n');
  console.log('  AscendOps uses Google Gemini embeddings to power the knowledge');
  console.log('  base. Free at typical small-operator volumes. You\'ll need a free');
  console.log('  Google account.\n');
  console.log('  Steps:');
  console.log('    1. Go to https://aistudio.google.com/apikey');
  console.log('    2. Sign in with your Google account (create one free if needed)');
  console.log('    3. Click "Create API key" — pick "Create API key in new project"');
  console.log('       or select an existing project');
  console.log('    4. Copy the key (starts with AIza... or AQ....)\n');
  console.log('  Your Gemini API key stays on this machine. AscendOps has no');
  console.log('  managed infrastructure — there is no server we send it to.\n');

  const secretsPath = join(projectRoot, 'orgs', org, SECRETS_FILENAME);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const key = await askMasked(iface, '  Paste your Gemini API key (AIza... or AQ..., input hidden): ');
    if (!key) {
      console.log('  Key is required for the knowledge base to function. Try again.');
      continue;
    }

    const verdict = await verifyGeminiKey(key);
    if (verdict === 'invalid') {
      if (attempt < 3) {
        console.log(`  Key rejected by Google (likely typo or revoked). Try again (attempt ${attempt + 1}/3) or Ctrl+C to bail.`);
      }
      continue;
    }
    if (verdict === 'network-fail') {
      console.log('  ! Could not reach Google to validate the key (network error). Accepting on trust — first agent KB call will surface any real problem.');
    } else {
      console.log('  ✓ Key validated against Gemini API.');
    }
    appendSecret(secretsPath, 'GEMINI_API_KEY', key);
    console.log(`  ✓ Key written to ${secretsPath}`);
    return;
  }
  console.log('  3 attempts failed. Re-run `cortextos configure` and pick "Gemini API key" once you have a working key.');
}

async function verifyGeminiKey(key: string): Promise<'ok' | 'invalid' | 'network-fail'> {
  // Best-effort validate — issue a single 1-token embedding request. 401/403
  // means the key is bad (re-prompt). Other 4xx is treated as bad too — Google
  // returns 400 on malformed keys. 5xx or transport-level failure → accept on
  // trust (network-fail-open, same pattern as the Slack/PM verify flows).
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent';
  try {
    const res = await fetch(`${url}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/text-embedding-004',
        content: { parts: [{ text: 'ping' }] },
      }),
    });
    if (res.ok) return 'ok';
    if (res.status >= 400 && res.status < 500) return 'invalid';
    return 'network-fail';
  } catch {
    return 'network-fail';
  }
}

async function screenHours(iface: import('readline').Interface): Promise<HoursSection> {
  console.log('\n  ── Day-mode hours + escalation ──\n');
  const day_mode_start = await askDefault(iface, '  Day-mode start (HH:MM 24h)', '08:00');
  const day_mode_end = await askDefault(iface, '  Day-mode end (HH:MM 24h)', '20:00');
  const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  const tzConfirm = await askYN(iface, `  Use detected timezone "${detectedTz}"?`, true);
  const timezone = tzConfirm ? detectedTz : await askRequired(iface, '  Timezone (IANA, e.g. America/New_York): ', 'Required.');
  const emergency_definition = await askDefault(
    iface,
    '  After-hours emergency definition (free-text)',
    'no-heat below freezing, active flood, fire, locked-out tenant after dark',
  );
  return { day_mode_start, day_mode_end, timezone, emergency_definition };
}

async function screenCommsTone(iface: import('readline').Interface): Promise<CommsToneSection> {
  console.log('\n  ── Comms tone ──\n');
  console.log('  This is the #1 thing that makes your agents sound like YOU, not generic AI.');
  console.log('  We recommend pasting 2-3 sentences of how you actually talk to tenants and');
  console.log('  vendors. The agents will lift rhythm, vocabulary, and register from this sample.');
  console.log('  You can skip if you must, but plain robotic output is the default fallback.\n');

  const style_tags = await askMultiChoice(iface, 'Pick style tags (multi-select):', STYLE_TAG_OPTIONS);
  const voice_sample = await askMultiline(iface, 'Voice sample (2-3 sentences):');
  return { style_tags, voice_sample };
}

function printTirithReminder(): void {
  console.log('\n  ── Recommended next step: install Tirith ──\n');
  console.log('  Tirith is a terminal security layer that watches every shell command your');
  console.log('  agents (and you) run and flags risky patterns before they execute.');
  console.log('  AscendOps does not bundle it (AGPL-3.0 license), but install is a single');
  console.log('  brew command and the default mode is warn-only.\n');
  console.log('  See SKOOL-INSTALL.md → "Recommended add-on — install Tirith" for the walkthrough.\n');
}

function printReviewSummary(profile: BusinessProfile): void {
  console.log('\n  ── Review ──\n');
  console.log(`  Company:   ${profile.company.legal_name}${profile.company.dba ? ` (DBA ${profile.company.dba})` : ''}, ${profile.company.primary_city}, ${profile.company.primary_state} — ${profile.company.door_count} doors`);
  console.log(`  PM:        ${profile.tech_stack.pm_software}${profile.tech_stack.pm_software_other ? ` (${profile.tech_stack.pm_software_other})` : ''}`);
  console.log(`  Leasing:   ${profile.tech_stack.leasing_tools.join(', ') || 'none'}`);
  console.log(`  Project:   ${profile.tech_stack.project_tracking.join(', ') || 'none'}`);
  console.log(`  Acct:     ${profile.tech_stack.accounting}${profile.tech_stack.accounting_other ? ` (${profile.tech_stack.accounting_other})` : ''}`);
  console.log(`  Hours:     ${profile.hours.day_mode_start}–${profile.hours.day_mode_end} ${profile.hours.timezone}`);
  console.log(`  Emergency: ${profile.hours.emergency_definition}`);
  console.log(`  Tone:      ${profile.comms_tone.style_tags.join(', ') || 'none'}`);
  if (profile.comms_tone.voice_sample) {
    const preview = profile.comms_tone.voice_sample.split('\n')[0].slice(0, 80);
    console.log(`  Voice:     "${preview}${profile.comms_tone.voice_sample.length > 80 ? '…' : ''}"`);
  } else {
    console.log('  Voice:     (skipped)');
  }
  console.log('');
}

function appendSecret(path: string, key: string, value: string): void {
  // Append-or-replace semantics: don't blow away existing secrets file. Only handle
  // the simple case of new key; if the key already exists, the operator will see
  // both lines on read and the OS-level env loader (last wins) handles it. Keeping
  // it simple to avoid edge cases on partial writes.
  const line = `${key}=${value}\n`;
  if (existsSync(path)) {
    appendFileSync(path, line);
  } else {
    atomicWriteSync(path, line);
    try {
      const { chmodSync } = require('fs') as typeof import('fs');
      chmodSync(path, 0o600);
    } catch { /* best effort */ }
  }
}
