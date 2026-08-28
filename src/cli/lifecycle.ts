import { Command } from 'commander';
import {
  collectLegacyStatus,
  LegacyStatusCollectionError,
} from '../lifecycle/legacy-status.js';
import { redactLifecycleStatus } from '../lifecycle/redact-status.js';
import {
  evaluateStatusCheck,
  normalizeStatusCheckPolicy,
  UnsupportedStatusCheckPolicyError,
} from '../lifecycle/check-status.js';
import type {
  LifecycleStatusErrorCode,
  LifecycleStatusErrorDetailCode,
  LifecycleStatusErrorDetails,
  LifecycleStatusErrorEnvelope,
  LifecycleStatusSnapshot,
  RedactedLifecycleStatusErrorEnvelope,
  RedactedLifecycleStatusSnapshot,
} from '../lifecycle/status-types.js';

const ERROR_MESSAGES: Record<LifecycleStatusErrorCode, string> = {
  CORTEXT_STATUS_INVALID_INSTANCE: 'The selected Cortext instance identifier is invalid.',
  CORTEXT_STATUS_INSTANCE_NOT_FOUND: 'No legacy Cortext instance was found for the selected identifier.',
  CORTEXT_STATUS_INSTANCE_AMBIGUOUS: 'Select exactly one Cortext instance.',
  CORTEXT_STATUS_INVALID_OPTION_COMBINATION: 'The selected lifecycle status options cannot be combined.',
  CORTEXT_STATUS_CONTRACT_REQUIRES_JSON: 'Contract negotiation requires JSON output.',
  CORTEXT_STATUS_CONTRACT_MODE_MISMATCH: 'The requested status contract does not match the output mode.',
  CORTEXT_STATUS_UNSUPPORTED_CONTRACT: 'The requested status contract is unsupported.',
  CORTEXT_STATUS_UNSUPPORTED_CHECK_POLICY: 'The requested status check policy is unsupported.',
  CORTEXT_STATUS_COLLECTION_FAILED: 'A trustworthy lifecycle status snapshot could not be assembled.',
};

const REDACTED_ERROR_MESSAGES: Record<LifecycleStatusErrorCode, string> = {
  ...ERROR_MESSAGES,
  CORTEXT_STATUS_INVALID_OPTION_COMBINATION:
    'The selected redacted-output options cannot be combined.',
};

const REDACTED_ERROR_DETAILS: Record<LifecycleStatusErrorCode, LifecycleStatusErrorDetailCode> = {
  CORTEXT_STATUS_INVALID_INSTANCE: 'INVALID_INSTANCE',
  CORTEXT_STATUS_INSTANCE_NOT_FOUND: 'INSTANCE_NOT_FOUND',
  CORTEXT_STATUS_INSTANCE_AMBIGUOUS: 'INSTANCE_AMBIGUOUS',
  CORTEXT_STATUS_INVALID_OPTION_COMBINATION: 'REDACT_WITH_PATHS',
  CORTEXT_STATUS_CONTRACT_REQUIRES_JSON: 'CONTRACT_WITHOUT_JSON',
  CORTEXT_STATUS_CONTRACT_MODE_MISMATCH: 'CONTRACT_MODE_MISMATCH',
  CORTEXT_STATUS_UNSUPPORTED_CONTRACT: 'UNSUPPORTED_CONTRACT',
  CORTEXT_STATUS_UNSUPPORTED_CHECK_POLICY: 'UNSUPPORTED_CHECK_POLICY',
  CORTEXT_STATUS_COLLECTION_FAILED: 'COLLECTION_FAILED',
};

export interface LifecycleStatusCliOptions {
  instance?: string;
  json?: boolean;
  redact?: boolean;
  paths?: boolean;
  contract?: string;
  check?: string;
}

export class LifecycleStatusCliError extends Error {
  constructor(
    public readonly code: LifecycleStatusErrorCode,
    public readonly exitCode: 2 | 3 | 4,
    public readonly detailCode: LifecycleStatusErrorDetailCode,
    public readonly details: LifecycleStatusErrorDetails = { detail_code: detailCode as Exclude<LifecycleStatusErrorDetailCode, 'INSTANCE_AMBIGUOUS'> },
  ) {
    super(ERROR_MESSAGES[code]);
  }
}

export function validateLifecycleStatusOptions(options: LifecycleStatusCliOptions): void {
  if (options.redact && options.paths) {
    throw new LifecycleStatusCliError(
      'CORTEXT_STATUS_INVALID_OPTION_COMBINATION', 2, 'REDACT_WITH_PATHS',
    );
  }
  if (options.contract && !options.json) {
    throw new LifecycleStatusCliError(
      'CORTEXT_STATUS_CONTRACT_REQUIRES_JSON', 2, 'CONTRACT_WITHOUT_JSON',
    );
  }
  if (options.check) normalizeStatusCheckPolicy(options.check);
  if (!options.contract) return;

  const expected = options.redact ? 'cortext.status.redacted/v1' : 'cortext.status/v1';
  const wrongMode = options.redact ? 'cortext.status/v1' : 'cortext.status.redacted/v1';
  if (options.contract === wrongMode) {
    throw new LifecycleStatusCliError(
      'CORTEXT_STATUS_CONTRACT_MODE_MISMATCH', 4, 'CONTRACT_MODE_MISMATCH',
    );
  }
  if (options.contract !== expected) {
    throw new LifecycleStatusCliError(
      'CORTEXT_STATUS_UNSUPPORTED_CONTRACT', 4, 'UNSUPPORTED_CONTRACT',
    );
  }
}

export function localErrorEnvelope(error: LifecycleStatusCliError): LifecycleStatusErrorEnvelope {
  return {
    schema_version: 'cortext.status.error/v1',
    ok: false,
    error: {
      code: error.code,
      message: ERROR_MESSAGES[error.code],
      details: error.details,
    },
  };
}

export function redactedErrorEnvelope(
  error: LifecycleStatusCliError,
): RedactedLifecycleStatusErrorEnvelope {
  return {
    schema_version: 'cortext.status.redacted.error/v1',
    ok: false,
    error: {
      code: error.code,
      message: REDACTED_ERROR_MESSAGES[error.code],
      detail_code: REDACTED_ERROR_DETAILS[error.code],
    } as RedactedLifecycleStatusErrorEnvelope['error'],
  };
}

export function renderLocalHuman(snapshot: LifecycleStatusSnapshot): string {
  const agents = snapshot.runtime.agents;
  const target = snapshot.scope.target_kind.toUpperCase();
  const layout = snapshot.scope.layout_kind === 'legacy_combined'
    ? 'LEGACY LAYOUT'
    : 'LAYOUT UNKNOWN';
  const lines = [
    `Cortext: ${snapshot.scope.resolved_instance_id}  ${target} / ${layout}`,
    `State:   ${snapshot.overall.status.toUpperCase()} — ${snapshot.overall.summary}`,
    '',
    `App:     ${snapshot.application.version ?? 'unknown'} (legacy evidence)`,
    `Runtime: daemon ${snapshot.runtime.daemon.status}; active processes ${agents.active_processes ?? 'unknown'}`,
    `Agents:  configured ${agents.configured ?? 'unknown'}; enabled ${agents.enabled ?? 'unknown'}; degraded ${agents.degraded ?? 'unknown'}`,
    `State:   schema unknown; ${snapshot.state.status}`,
    `Recovery: no managed checkpoint or backup known`,
  ];
  if (snapshot.application.root || snapshot.state.root) {
    lines.push('', 'Paths');
    if (snapshot.application.root) lines.push(`Application: ${snapshot.application.root}`);
    if (snapshot.state.root) lines.push(`State:       ${snapshot.state.root}`);
  }
  if (snapshot.observations.length > 0) {
    lines.push('', 'Observations');
    for (const observation of snapshot.observations) {
      lines.push(`- [${observation.severity}] ${observation.code}: ${observation.summary}`);
    }
  }
  if (snapshot.check) {
    lines.push(
      '',
      `Check: ${snapshot.check.policy}@v1 ${snapshot.check.result.toUpperCase()}`,
      ...snapshot.check.reason_codes.map(code => `- ${code}`),
    );
  }
  lines.push(
    '',
    'No configuration, lifecycle state, or process lifecycle was changed.',
    'A responsive daemon may record normal access logs for the status request.',
  );
  return lines.join('\n');
}

export function renderRedactedHuman(snapshot: RedactedLifecycleStatusSnapshot): string {
  const runtime = snapshot.runtime;
  const target = snapshot.scope.target_kind.toUpperCase();
  const layout = snapshot.scope.layout_kind === 'legacy_combined'
    ? 'LEGACY LAYOUT'
    : 'LAYOUT UNKNOWN';
  const lines = [
    `Cortext: ${snapshot.scope.instance_alias}  ${target} / ${layout} / REDACTED`,
    `State:   ${snapshot.overall.status.toUpperCase()}`,
    '',
    `App:     ${snapshot.application.version ?? 'unknown'} (legacy evidence)`,
    `Runtime: daemon ${runtime.daemon_status}; active process count ${runtime.active_process_count_bucket ?? 'unknown'}`,
    `Agents:  configured count ${runtime.agent_count_bucket ?? 'unknown'}; degraded count ${runtime.degraded_agent_count_bucket ?? 'unknown'}`,
  ];
  if (snapshot.observations.length > 0) {
    lines.push('', 'Observation codes');
    for (const observation of snapshot.observations) {
      lines.push(`- [${observation.severity}] ${observation.code}`);
    }
  }
  if (snapshot.check) {
    lines.push(
      '',
      `Check: ${snapshot.check.policy}@v1 ${snapshot.check.result.toUpperCase()}`,
      ...snapshot.check.reason_codes.map(code => `- ${code}`),
    );
  }
  lines.push('', 'Privacy-minimized output still requires review before sharing.');
  return lines.join('\n');
}

function normalizeError(error: unknown): LifecycleStatusCliError {
  if (error instanceof LifecycleStatusCliError) return error;
  if (error instanceof LegacyStatusCollectionError) {
    if (error.code === 'CORTEXT_STATUS_INSTANCE_AMBIGUOUS') {
      return new LifecycleStatusCliError(
        error.code,
        2,
        'INSTANCE_AMBIGUOUS',
        { candidate_count: error.candidateCount ?? 0 },
      );
    }
    return new LifecycleStatusCliError(
      error.code,
      2,
      error.code === 'CORTEXT_STATUS_INVALID_INSTANCE' ? 'INVALID_INSTANCE' : 'INSTANCE_NOT_FOUND',
    );
  }
  if (error instanceof UnsupportedStatusCheckPolicyError) {
    return new LifecycleStatusCliError(
      'CORTEXT_STATUS_UNSUPPORTED_CHECK_POLICY', 4, 'UNSUPPORTED_CHECK_POLICY',
    );
  }
  return new LifecycleStatusCliError(
    'CORTEXT_STATUS_COLLECTION_FAILED', 3, 'COLLECTION_FAILED',
  );
}

export async function runLifecycleStatus(options: LifecycleStatusCliOptions): Promise<number> {
  try {
    validateLifecycleStatusOptions(options);
    const collected = await collectLegacyStatus({
      instanceId: options.instance,
      includePaths: options.paths === true,
    });
    const check = options.check ? evaluateStatusCheck(collected, options.check) : null;
    const snapshot: LifecycleStatusSnapshot = { ...collected, check };
    if (options.redact) {
      const redacted = redactLifecycleStatus(snapshot);
      process.stdout.write(options.json
        ? `${JSON.stringify(redacted, null, 2)}\n`
        : `${renderRedactedHuman(redacted)}\n`);
    } else {
      process.stdout.write(options.json
        ? `${JSON.stringify(snapshot, null, 2)}\n`
        : `${renderLocalHuman(snapshot)}\n`);
    }
    return check?.result === 'fail' ? 1 : 0;
  } catch (rawError) {
    const error = normalizeError(rawError);
    if (options.json) {
      const envelope = options.redact ? redactedErrorEnvelope(error) : localErrorEnvelope(error);
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`Error [${error.code}]: ${ERROR_MESSAGES[error.code]}\n`);
    }
    return error.exitCode;
  }
}

export const lifecycleStatusCommand = new Command('status')
  .description('Inspect a legacy Cortext installation without changing it')
  .option('--instance <id>', 'Legacy instance ID')
  .option('--json', 'Emit the machine-readable status contract')
  .option('--redact', 'Emit a privacy-minimized projection')
  .option('--paths', 'Include normalized local roots (never valid with --redact)')
  .option('--contract <contract>', 'Require an exact JSON contract')
  .option('--check <policy[@version]>', 'Evaluate a pinned lifecycle status policy')
  .action(async (options: LifecycleStatusCliOptions) => {
    process.exitCode = await runLifecycleStatus(options);
  });

export const lifecycleCommand = new Command('lifecycle')
  .description('Read-only lifecycle inspection commands')
  .addCommand(lifecycleStatusCommand);
