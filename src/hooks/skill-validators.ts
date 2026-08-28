/**
 * Skill validators, extracted from hook-skill-autopr.ts so that non-hook code can
 * use them WITHOUT importing a hook module.
 *
 * The extraction is the fix, not a tidy-up. `bus/skill-autopr.ts` imported these
 * two functions from the hook, `cli/bus.ts` imports that, and the hook ran its
 * session-credential strip at module top level — so loading ANY `cortextos bus`
 * subcommand deleted the credential before the command ran, and genuine
 * in-session activity stopped refreshing. A module with a side effect is not a
 * library, however useful its exports are.
 */

export interface FrontmatterValidation {
  valid: boolean;
  frontmatter: SkillFrontmatter;
  error?: string;
  warnings: string[];
}

export interface SecurityScanResult {
  clean: boolean;
  flags: string[];
}

export function parseFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result: SkillFrontmatter = {};

  for (const line of yaml.split('\n')) {
    const kvMatch = line.match(/^([a-z_]+):\s*(.+)$/);
    if (!kvMatch) continue;

    const [, key, rawValue] = kvMatch;
    const value = rawValue.trim();

    if (key === 'triggers' || key === 'external_calls') {
      // Inline array: ["a", "b"] or [a, b]
      const items = value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      (result as Record<string, unknown>)[key] = items;
    } else {
      // Scalar: strip surrounding quotes
      (result as Record<string, unknown>)[key] = value.replace(/^["']|["']$/g, '');
    }
  }

  return result;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  triggers?: string[];
  external_calls?: string[];
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
}

export function scanForSecurityIssues(content: string): SecurityScanResult {
  const flags: string[] = [];
  const lower = content.toLowerCase();

  // Reverse shell / network exfiltration
  if (/\bNC\b.*-[le]|\bnetcat\b|\/dev\/tcp\//i.test(content)) {
    flags.push('Possible reverse shell: nc/netcat or /dev/tcp pattern detected');
  }
  if (/curl\s+.*\|\s*(bash|sh)|wget\s+.*\|\s*(bash|sh)/i.test(content)) {
    flags.push('Pipe-to-shell pattern: remote code execution risk (curl|bash, wget|bash)');
  }

  // Credential / secret exfiltration
  if (/api[_-]?key|secret[_-]?key|access[_-]?token|bearer\s+[a-z0-9]{20}/i.test(content)) {
    flags.push('Credential keyword detected — verify no hardcoded secrets or exfiltration of env vars');
  }
  if (/\$HOME\/\.claude|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH/i.test(content)) {
    flags.push('References sensitive agent credential paths or env vars');
  }

  // Base64-encoded payloads (common malware delivery method).
  // Filter out pure URL paths and alphanumeric-only strings (hex, IDs) by requiring
  // at least one + or / character — these are structurally required in base64 but
  // absent in most URLs and hex strings.
  const base64Matches = (content.match(/[A-Za-z0-9+/]{50,}={0,2}/g) || [])
    .filter(m => m.includes('+') || m.includes('/'));
  if (base64Matches.length > 0) {
    flags.push(`Long base64-like string(s) detected (${base64Matches.length}) — check for encoded payloads`);
  }

  // Prompt injection patterns
  if (/ignore previous instructions|disregard.*instructions|new instructions.*override/i.test(content)) {
    flags.push('Classic prompt injection phrase detected');
  }
  if (/if (user|human) (asks?|says?|requests?).*(exfiltrate|steal|send|upload|transmit)/i.test(content)) {
    flags.push('Conditional exfiltration instruction pattern detected');
  }
  if (/do not (tell|show|mention|reveal|inform).*user/i.test(content)) {
    flags.push('Instruction to conceal actions from user detected');
  }

  // Destructive commands
  if (/rm\s+-rf\s+[/~]|DROP\s+TABLE|DELETE\s+FROM.*WHERE\s+1/i.test(content)) {
    flags.push('Destructive command pattern detected (rm -rf, DROP TABLE, etc.)');
  }

  // External data upload
  if (/\bupload\b.*\b(http|ftp|s3)|\bsend\b.*\bwebhook\b|\bpost\b.*\bsecret/i.test(lower)) {
    flags.push('Potential external data upload pattern detected');
  }

  return { clean: flags.length === 0, flags };
}

export function validateFrontmatter(content: string, expectedName: string): FrontmatterValidation {
  const frontmatter = parseFrontmatter(content);
  const warnings: string[] = [];

  if (!frontmatter.name) {
    return { valid: false, frontmatter, error: 'Missing required field: name', warnings };
  }
  if (!frontmatter.description) {
    return { valid: false, frontmatter, error: 'Missing required field: description', warnings };
  }
  if (frontmatter.name !== expectedName) {
    return {
      valid: false,
      frontmatter,
      error: `Frontmatter name "${frontmatter.name}" does not match directory name "${expectedName}" (agentskills.io requirement)`,
      warnings,
    };
  }

  // Recommended fields (warn but don't reject)
  if (!frontmatter.triggers || frontmatter.triggers.length === 0) {
    warnings.push('No triggers defined — skill will not be auto-loaded by trigger matching');
  }
  if (!frontmatter.external_calls) {
    warnings.push('external_calls not declared — consider adding [] if skill makes no external calls');
  }

  return { valid: true, frontmatter, warnings };
}
