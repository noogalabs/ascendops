import { describe, expect, it } from 'vitest';

type ScenarioName =
  | 'disable-while-deferred'
  | 'explicit-stop-cancels-deferred'
  | 'individual-restart-notification'
  | 'ordinary-ipc-start-retries'
  | 'direct-restart-owns-retry'
  | 'ipc-restart-single-entry'
  | 'shutdown-cancels-and-gates'
  | 'fleet-accounting-after-spawn'
  | 'daemon-crash-reconstructs-operation'
  | 'stop-during-spawning-reaps-child'
  | 'shutdown-during-spawning-reaps-child'
  | 'restart-phase-single-replacement'
  | 'restart-boot-reconstruction'
  | 'child-receipt-kernel-binding'
  | 'restart-receipt-continuity'
  | 'completion-outbox-crash-windows'
  | 'concurrent-request-dedupe-and-in-flight'
  | 'native-peer-is-measured-not-asserted'
  | 'supervisor-death-enters-stale-reclaim'
  | 'lost-grant-idempotent-recovery'
  | 'daemon-restart-reconstructs-lease'
  | 'census-to-prune-race-refuses'
  | 'post-prune-census-failure-freezes-counts'
  | 'writer-fence-covers-shipped-writers'
  | 'dry-run-discriminates-without-delete'
  | 'legacy-five-condition-gate-fails-closed'
  | 'lease-scope-binds-machine-and-reaper'
  | 'request-id-is-durable-before-acquire'
  | 'same-request-recovery-precedes-peer-refusal';

const scenarios: ScenarioName[] = [
  'disable-while-deferred',
  'explicit-stop-cancels-deferred',
  'individual-restart-notification',
  'ordinary-ipc-start-retries',
  'direct-restart-owns-retry',
  'ipc-restart-single-entry',
  'shutdown-cancels-and-gates',
  'fleet-accounting-after-spawn',
  'daemon-crash-reconstructs-operation',
  'stop-during-spawning-reaps-child',
  'shutdown-during-spawning-reaps-child',
  'restart-phase-single-replacement',
  'restart-boot-reconstruction',
  'child-receipt-kernel-binding',
  'restart-receipt-continuity',
  'completion-outbox-crash-windows',
  'concurrent-request-dedupe-and-in-flight',
  'native-peer-is-measured-not-asserted',
  'supervisor-death-enters-stale-reclaim',
  'lost-grant-idempotent-recovery',
  'daemon-restart-reconstructs-lease',
  'census-to-prune-race-refuses',
  'post-prune-census-failure-freezes-counts',
  'writer-fence-covers-shipped-writers',
  'dry-run-discriminates-without-delete',
  'legacy-five-condition-gate-fails-closed',
  'lease-scope-binds-machine-and-reaper',
  'request-id-is-durable-before-acquire',
  'same-request-recovery-precedes-peer-refusal',
];

describe('PR267 frozen-v6 casualties', () => {
  for (const scenario of scenarios) {
    it(scenario, async () => {
      // The tests-only red head deliberately omits this helper. The green
      // implementation must add a real scenario driver whose observations are
      // bound to production adapters; a blanket true-returning stub is not an
      // admissible closure and will be mutation-checked per scenario.
      const { runPr267Scenario } = await import('../../helpers/pr267-v6-scenarios');
      await expect(runPr267Scenario(scenario)).resolves.toEqual({
        scenario,
        observed: true,
      });
    });
  }
});
