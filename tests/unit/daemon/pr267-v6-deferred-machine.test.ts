import { describe, expect, it } from 'vitest';
import { runDeferredStartScenario, type DeferredScenarioName } from '../../helpers/pr267-v6-deferred-scenarios';

const scenarios: DeferredScenarioName[] = [
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
];

describe('PR267 frozen-v6 deferred operation machine', () => {
  for (const scenario of scenarios) {
    it(scenario, async () => {
      await expect(runDeferredStartScenario(scenario)).resolves.toEqual({ scenario, observed: true });
    });
  }
});
