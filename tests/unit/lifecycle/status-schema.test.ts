import Ajv from 'ajv';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectLegacyStatus } from '../../../src/lifecycle/legacy-status';
import { redactLifecycleStatus } from '../../../src/lifecycle/redact-status';
import { evaluateStatusCheck } from '../../../src/lifecycle/check-status';
import {
  LEGACY_PARTIAL_OBSERVATION_CODES,
  LEGACY_STATUS_OBSERVATIONS,
} from '../../../src/lifecycle/status-contract';
import {
  LifecycleStatusCliError,
  localErrorEnvelope,
  redactedErrorEnvelope,
} from '../../../src/cli/lifecycle';

const roots: string[] = [];

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(join(process.cwd(), 'schemas', name), 'utf-8'));
}

function objectPaths(value: unknown, path: Array<string | number> = []): Array<Array<string | number>> {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => objectPaths(item, [...path, index]));
  }
  const record = value as Record<string, unknown>;
  return [path, ...Object.entries(record).flatMap(([key, item]) => objectPaths(item, [...path, key]))];
}

function objectAt(root: unknown, path: Array<string | number>): Record<string, unknown> {
  let current = root as unknown;
  for (const segment of path) current = (current as Record<string | number, unknown>)[segment];
  return current as Record<string, unknown>;
}

function passingCheck(policy: string) {
  return {
    policy,
    policy_version: `cortext.check.${policy}/v1`,
    result: 'pass',
    reason_codes: [],
  };
}

async function fixtureSnapshot() {
  const root = mkdtempSync(join(tmpdir(), 'cortext-status-schema-'));
  roots.push(root);
  const frameworkRoot = join(root, 'framework');
  const ctxRoot = join(root, 'state');
  mkdirSync(join(ctxRoot, 'state'), { recursive: true });
  mkdirSync(frameworkRoot, { recursive: true });
  writeFileSync(
    join(frameworkRoot, 'package.json'),
    JSON.stringify({ name: 'cortextos', version: '0.1.1' }),
    'utf-8',
  );
  return collectLegacyStatus({
    instanceId: 'default',
    ctxRoot,
    frameworkRoot,
    now: new Date('2026-08-10T12:00:00.000Z'),
    probeDaemon: async () => ({ kind: 'absent' }),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('lifecycle status JSON Schemas', () => {
  it('validates emitted local and redacted snapshots', async () => {
    const local = await fixtureSnapshot();
    const checked = { ...local, check: evaluateStatusCheck(local, 'usable@v1') };
    const redacted = redactLifecycleStatus(checked, '00000000-0000-4000-8000-000000000000');
    const ajv = new Ajv({ allErrors: true, strict: true });

    const validateLocal = ajv.compile(loadSchema('cortext.status.v1.schema.json'));
    const validateRedacted = ajv.compile(loadSchema('cortext.status.redacted.v1.schema.json'));
    expect(validateLocal(checked), JSON.stringify(validateLocal.errors)).toBe(true);
    expect(validateRedacted(redacted), JSON.stringify(validateRedacted.errors)).toBe(true);
  });

  it('rejects additional redacted properties recursively', async () => {
    const local = await fixtureSnapshot();
    const redacted = redactLifecycleStatus(local, '00000000-0000-4000-8000-000000000000');
    const validate = new Ajv({ allErrors: true, strict: true })
      .compile(loadSchema('cortext.status.redacted.v1.schema.json'));

    for (const path of objectPaths(redacted)) {
      const candidate = structuredClone(redacted) as unknown;
      objectAt(candidate, path).private_canary = 'SECRET';
      expect(validate(candidate), `accepted extra property at ${JSON.stringify(path)}`).toBe(false);
    }
  });

  it('reconstructs every redacted string surface from closed public metadata', async () => {
    const local = await fixtureSnapshot();
    const adversarial = structuredClone(local) as any;
    adversarial.manager.version = '/Users/private/manager';
    adversarial.application.version = 'private@example.com';
    adversarial.capabilities.supported = ['TOKEN_SECRET_CANARY'];
    adversarial.capabilities.unsupported = ['PRIVATE_OPERATION_CANARY'];
    adversarial.runtime.isolation.evidence_codes = ['PRIVATE_EVIDENCE_CANARY'];
    adversarial.runtime.isolation.network = 'PRIVATE_NETWORK_CANARY';
    adversarial.check = {
      policy: 'usable',
      policy_version: 'cortext.check.security-contained/v1',
      result: 'pass',
      reason_codes: ['TOKEN_SECRET_CANARY'],
    };
    adversarial.observations = [{
      code: 'PRIVATE_OBSERVATION_CANARY',
      severity: 'critical',
      domain: 'private@example.com',
      summary: '/Users/private/summary',
      recommended_operation: 'TOKEN_SECRET_CANARY',
    }];

    const redacted = redactLifecycleStatus(
      adversarial,
      '00000000-0000-4000-8000-000000000000',
    );
    const serialized = JSON.stringify(redacted);
    for (const canary of [
      '/Users/private',
      'private@example.com',
      'TOKEN_SECRET_CANARY',
      'PRIVATE_OPERATION_CANARY',
      'PRIVATE_EVIDENCE_CANARY',
      'PRIVATE_NETWORK_CANARY',
      'PRIVATE_OBSERVATION_CANARY',
    ]) expect(serialized).not.toContain(canary);
    expect(redacted.check).toEqual({
      policy: 'usable',
      policy_version: 'cortext.check.usable/v1',
      result: 'pass',
      reason_codes: [],
    });
    expect(redacted.observations).toEqual([]);

    const validate = new Ajv({ allErrors: true, strict: true })
      .compile(loadSchema('cortext.status.redacted.v1.schema.json'));
    expect(validate(redacted), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects forged secret-bearing values on every formerly open redacted surface', async () => {
    const local = await fixtureSnapshot();
    const base = redactLifecycleStatus(local, '00000000-0000-4000-8000-000000000000');
    const validate = new Ajv({ allErrors: true, strict: true })
      .compile(loadSchema('cortext.status.redacted.v1.schema.json'));
    const mutations: Array<(candidate: any) => void> = [
      candidate => { candidate.report_id = '/Users/private/TOKEN_SECRET_CANARY'; },
      candidate => { candidate.observed_day = 'private@example.com'; },
      candidate => { candidate.manager.version = 'TOKEN_SECRET_CANARY'; },
      candidate => { candidate.application.version = 'private@example.com'; },
      candidate => { candidate.capabilities.supported[0] = '/Users/private/capability'; },
      candidate => { candidate.capabilities.unsupported[0] = 'TOKEN_SECRET_CANARY'; },
      candidate => { candidate.runtime.isolation.evidence_codes = ['PRIVATE_EVIDENCE_CANARY']; },
      candidate => { candidate.observations[0].code = 'PRIVATE_OBSERVATION_CANARY'; },
      candidate => { candidate.observations[0].severity = 'critical'; },
      candidate => { candidate.observations[0].domain = 'private@example.com'; },
      candidate => { candidate.observations[0].recommended_operation = '/Users/private/action'; },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(base) as any;
      mutate(candidate);
      expect(validate(candidate), JSON.stringify(validate.errors)).toBe(false);
    }
  });

  it('rejects contradictory policy, version, result, and reason combinations', async () => {
    const local = await fixtureSnapshot();
    const contradictory = {
      ...local,
      check: {
        policy: 'usable',
        policy_version: 'cortext.check.security-contained/v1',
        result: 'pass',
        reason_codes: ['CORTEXT_CHECK_STATE_NOT_READABLE'],
      },
    };
    const validate = new Ajv({ allErrors: true, strict: true })
      .compile(loadSchema('cortext.status.v1.schema.json'));
    expect(validate(contradictory)).toBe(false);

    const wrongPolicyReason = {
      ...local,
      check: {
        policy: 'usable',
        policy_version: 'cortext.check.usable/v1',
        result: 'fail',
        reason_codes: ['CORTEXT_CHECK_CREDENTIALS_EXPOSED'],
      },
    };
    expect(validate(wrongPolicyReason)).toBe(false);
  });

  it('rejects passing checks contradicted by normative snapshot facts', async () => {
    const local = await fixtureSnapshot();
    const redacted = redactLifecycleStatus(
      local,
      '00000000-0000-4000-8000-000000000000',
    );
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validateLocal = ajv.compile(loadSchema('cortext.status.v1.schema.json'));
    const validateRedacted = ajv.compile(loadSchema('cortext.status.redacted.v1.schema.json'));
    for (const [document, validate] of [
      [local, validateLocal],
      [redacted, validateRedacted],
    ] as const) {
      const updateSafe = structuredClone(document) as any;
      updateSafe.check = passingCheck('update-safe');
      expect(validate(updateSafe), JSON.stringify(validate.errors)).toBe(false);

      const unusableState = structuredClone(document) as any;
      unusableState.check = passingCheck('usable');
      unusableState.state.status = 'missing';
      expect(validate(unusableState), JSON.stringify(validate.errors)).toBe(false);

      const unusableOverall = structuredClone(document) as any;
      unusableOverall.check = passingCheck('usable');
      unusableOverall.overall.status = 'blocked';
      expect(validate(unusableOverall), JSON.stringify(validate.errors)).toBe(false);

      const blockedButUsable = structuredClone(document) as any;
      blockedButUsable.check = passingCheck('usable');
      blockedButUsable.overall.status = 'degraded';
      const blockingMetadata = LEGACY_STATUS_OBSERVATIONS.CORTEXT_STATUS_STATE_UNREADABLE;
      blockedButUsable.observations.push(document.schema_version === 'cortext.status/v1'
        ? { code: 'CORTEXT_STATUS_STATE_UNREADABLE', ...blockingMetadata }
        : {
          code: 'CORTEXT_STATUS_STATE_UNREADABLE',
          severity: blockingMetadata.severity,
          domain: blockingMetadata.domain,
          recommended_operation: blockingMetadata.recommended_operation,
        });
      expect(validate(blockedButUsable), JSON.stringify(validate.errors)).toBe(false);

      const stoppedButHealthy = structuredClone(document) as any;
      stoppedButHealthy.check = passingCheck('healthy');
      stoppedButHealthy.overall = { status: 'healthy', highest_severity: 'info' };
      expect(validate(stoppedButHealthy), JSON.stringify(validate.errors)).toBe(false);

      const criticalButHealthy = structuredClone(document) as any;
      criticalButHealthy.check = passingCheck('healthy');
      criticalButHealthy.overall = { status: 'healthy', highest_severity: 'info' };
      if (document.schema_version === 'cortext.status/v1') {
        criticalButHealthy.runtime.daemon.status = 'running';
        criticalButHealthy.runtime.daemon.ipc_status = 'responsive';
      } else {
        criticalButHealthy.runtime.daemon_status = 'running';
      }
      const criticalMetadata = LEGACY_STATUS_OBSERVATIONS.CORTEXT_STATUS_STATE_UNREADABLE;
      criticalButHealthy.observations.push(document.schema_version === 'cortext.status/v1'
        ? { code: 'CORTEXT_STATUS_STATE_UNREADABLE', ...criticalMetadata }
        : {
          code: 'CORTEXT_STATUS_STATE_UNREADABLE',
          severity: criticalMetadata.severity,
          domain: criticalMetadata.domain,
          recommended_operation: criticalMetadata.recommended_operation,
        });
      expect(validate(criticalButHealthy), JSON.stringify(validate.errors)).toBe(false);

      const namespace = structuredClone(document) as any;
      namespace.check = passingCheck('sandbox-namespace');
      expect(validate(namespace), JSON.stringify(validate.errors)).toBe(false);

      const contained = structuredClone(document) as any;
      contained.check = passingCheck('security-contained');
      expect(validate(contained), JSON.stringify(validate.errors)).toBe(false);
    }
  });

  it('derives partial status from every canonical partial observation', async () => {
    expect(new Set(LEGACY_PARTIAL_OBSERVATION_CODES).size)
      .toBe(LEGACY_PARTIAL_OBSERVATION_CODES.length);
    const local = await fixtureSnapshot();
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validateLocal = ajv.compile(loadSchema('cortext.status.v1.schema.json'));
    const validateRedacted = ajv.compile(loadSchema('cortext.status.redacted.v1.schema.json'));

    for (const code of LEGACY_PARTIAL_OBSERVATION_CODES) {
      const metadata = LEGACY_STATUS_OBSERVATIONS[code];
      const forged = structuredClone(local) as any;
      forged.snapshot_status = 'complete';
      forged.overall = { status: 'degraded', highest_severity: metadata.severity };
      forged.observations.push({ code, ...metadata });
      forged.check = passingCheck('usable');

      expect(evaluateStatusCheck(forged, 'usable@v1').reason_codes, code).toContain(
        'CORTEXT_CHECK_SNAPSHOT_INCOMPLETE',
      );
      const isolated = structuredClone(forged) as any;
      isolated.scope.target_kind = 'sandbox';
      isolated.runtime.isolation = {
        boundary: 'vm',
        data_roots: 'isolated',
        process_namespace: 'isolated',
        managed_integrations: 'intercepted',
        credentials: 'removed',
        network: 'none',
        host_access: 'constrained',
        claim: 'security_contained',
        evidence_codes: [
          'CORTEXT_ISOLATION_LIVE_ROOT_DISJOINT',
          'CORTEXT_ISOLATION_PROCESS_NAMESPACE_DISJOINT',
          'CORTEXT_ISOLATION_MANAGED_INTEGRATIONS_ROUTED',
          'CORTEXT_ISOLATION_BOUNDARY_ENFORCED',
          'CORTEXT_ISOLATION_HOST_CREDENTIALS_UNAVAILABLE',
          'CORTEXT_ISOLATION_EGRESS_POLICY_ENFORCED',
          'CORTEXT_ISOLATION_HOST_ACCESS_CONSTRAINED',
        ],
      };
      for (const policy of ['sandbox-namespace@v1', 'security-contained@v1']) {
        const normalizedPolicy = policy.slice(0, -3);
        expect(evaluateStatusCheck(isolated, policy), `${code}: ${policy}`).toEqual({
          policy: normalizedPolicy,
          policy_version: `cortext.check.${normalizedPolicy}/v1`,
          result: 'fail',
          reason_codes: ['CORTEXT_CHECK_SNAPSHOT_INCOMPLETE'],
        });
      }
      expect(validateLocal(forged), `${code}: ${JSON.stringify(validateLocal.errors)}`)
        .toBe(false);

      const redacted = redactLifecycleStatus(
        forged,
        '00000000-0000-4000-8000-000000000000',
      );
      expect(redacted.snapshot_status, code).toBe('partial');
      expect(redacted.check?.result, code).toBe('fail');
      expect(redacted.check?.reason_codes, code).toContain('CORTEXT_CHECK_SNAPSHOT_INCOMPLETE');
      expect(redacted.observations, code).toContainEqual(expect.objectContaining({
        code,
        severity: metadata.severity,
        domain: metadata.domain,
      }));
      expect(validateRedacted(redacted), `${code}: ${JSON.stringify(validateRedacted.errors)}`)
        .toBe(true);

      const impossible = structuredClone(redacted) as any;
      impossible.snapshot_status = 'complete';
      impossible.check = passingCheck('usable');
      expect(validateRedacted(impossible), code).toBe(false);
    }
  });

  it('recomputes forged passing checks before redacted projection', async () => {
    const local = await fixtureSnapshot();
    const forged = structuredClone(local) as any;
    forged.check = {
      policy: 'security-contained',
      policy_version: 'cortext.check.security-contained/v1',
      result: 'pass',
      reason_codes: [],
    };
    const redacted = redactLifecycleStatus(
      forged,
      '00000000-0000-4000-8000-000000000000',
    );
    expect(redacted.check?.result).toBe('fail');
    expect(redacted.check?.reason_codes).toEqual(expect.arrayContaining([
      'CORTEXT_CHECK_TARGET_NOT_SANDBOX',
      'CORTEXT_CHECK_NETWORK_UNCONSTRAINED',
      'CORTEXT_CHECK_HOST_ACCESS_FULL',
    ]));
    expect(redacted.runtime.isolation).toMatchObject({
      boundary: 'none',
      data_roots: 'live',
      network: 'unrestricted',
      host_access: 'full',
    });
    const validate = new Ajv({ allErrors: true, strict: true })
      .compile(loadSchema('cortext.status.redacted.v1.schema.json'));
    expect(validate(redacted), JSON.stringify(validate.errors)).toBe(true);
  });

  it('derives redacted overall and healthy checks from daemon and canonical observations', async () => {
    const local = await fixtureSnapshot();
    const forgedStopped = structuredClone(local) as any;
    forgedStopped.overall = { status: 'healthy', highest_severity: 'info' };
    forgedStopped.check = {
      policy: 'healthy',
      policy_version: 'cortext.check.healthy/v1',
      result: 'pass',
      reason_codes: [],
    };
    const stopped = redactLifecycleStatus(
      forgedStopped,
      '00000000-0000-4000-8000-000000000000',
    );
    expect(stopped.runtime.daemon_status).toBe('stopped');
    expect(stopped.overall.status).toBe('stopped');
    expect(stopped.check).toMatchObject({
      policy: 'healthy',
      result: 'fail',
    });
    expect(stopped.check?.reason_codes).toEqual(expect.arrayContaining([
      'CORTEXT_CHECK_DAEMON_NOT_RUNNING',
      'CORTEXT_CHECK_OVERALL_DISALLOWED',
    ]));

    const forgedObservation = structuredClone(local) as any;
    forgedObservation.runtime.daemon.status = 'running';
    forgedObservation.runtime.daemon.ipc_status = 'responsive';
    forgedObservation.overall = { status: 'healthy', highest_severity: 'info' };
    forgedObservation.observations.push({
      code: 'CORTEXT_STATUS_STATE_UNREADABLE',
      severity: 'info',
      domain: 'legacy',
      summary: 'forged',
      recommended_operation: null,
    });
    forgedObservation.check = {
      policy: 'healthy',
      policy_version: 'cortext.check.healthy/v1',
      result: 'pass',
      reason_codes: [],
    };
    const critical = redactLifecycleStatus(
      forgedObservation,
      '00000000-0000-4000-8000-000000000000',
    );
    expect(critical.overall).toEqual({ status: 'blocked', highest_severity: 'critical' });
    expect(critical.observations).toContainEqual(expect.objectContaining({
      code: 'CORTEXT_STATUS_STATE_UNREADABLE',
      severity: 'critical',
      domain: 'state',
    }));
    expect(critical.check?.result).toBe('fail');
    expect(critical.check?.reason_codes).toContain('CORTEXT_CHECK_LIFECYCLE_ERROR_PRESENT');

    const validate = new Ajv({ allErrors: true, strict: true })
      .compile(loadSchema('cortext.status.redacted.v1.schema.json'));
    expect(validate(stopped), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(critical), JSON.stringify(validate.errors)).toBe(true);
  });

  it('defines v1 as a legacy-only contract instead of advertising managed evidence', async () => {
    const local = await fixtureSnapshot();
    const managedShaped = structuredClone(local) as any;
    managedShaped.capabilities.profile = 'managed_running_v1';
    managedShaped.basis.lifecycle_generation = 'generation-1';
    const validate = new Ajv({ allErrors: true, strict: true })
      .compile(loadSchema('cortext.status.v1.schema.json'));
    expect(validate(managedShaped)).toBe(false);
  });

  it('validates both closed error envelopes', () => {
    const error = new LifecycleStatusCliError(
      'CORTEXT_STATUS_INVALID_OPTION_COMBINATION', 2, 'REDACT_WITH_PATHS',
    );
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validateLocal = ajv.compile(loadSchema('cortext.status.error.v1.schema.json'));
    const validateRedacted = ajv.compile(loadSchema('cortext.status.redacted.error.v1.schema.json'));

    expect(validateLocal(localErrorEnvelope(error)), JSON.stringify(validateLocal.errors)).toBe(true);
    expect(
      validateRedacted(redactedErrorEnvelope(error)),
      JSON.stringify(validateRedacted.errors),
    ).toBe(true);
  });

  it('reconstructs redacted error metadata and rejects private or contradictory errors', () => {
    const forged = new LifecycleStatusCliError(
      'CORTEXT_STATUS_INVALID_INSTANCE', 2, 'COLLECTION_FAILED',
    );
    const emitted = redactedErrorEnvelope(forged);
    expect(emitted.error).toEqual({
      code: 'CORTEXT_STATUS_INVALID_INSTANCE',
      message: 'The selected Cortext instance identifier is invalid.',
      detail_code: 'INVALID_INSTANCE',
    });
    const validate = new Ajv({ allErrors: true, strict: true })
      .compile(loadSchema('cortext.status.redacted.error.v1.schema.json'));
    expect(validate(emitted), JSON.stringify(validate.errors)).toBe(true);

    const malicious = structuredClone(emitted) as any;
    malicious.error.message = '/Users/private/TOKEN_SECRET_CANARY';
    malicious.error.detail_code = 'COLLECTION_FAILED';
    expect(validate(malicious)).toBe(false);
  });
});
