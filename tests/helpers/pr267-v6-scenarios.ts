import {
  runDeferredStartScenario,
  type DeferredScenarioName,
} from './pr267-v6-deferred-scenarios';
import {
  runPr267LeaseScenario,
  type Pr267LeaseScenarioName,
} from './pr267-v6-lease-scenarios';
import {
  runPr267ReaperScenario,
  type Pr267ReaperScenarioName,
} from './pr267-v6-reaper-scenarios';

type ScenarioName = DeferredScenarioName | Pr267LeaseScenarioName
  | 'census-to-prune-race-refuses'
  | 'post-prune-census-failure-freezes-counts'
  | 'writer-fence-covers-shipped-writers'
  | 'dry-run-discriminates-without-delete'
  | 'legacy-five-condition-gate-fails-closed';

const deferred = new Set<ScenarioName>([
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
]);

const lease = new Set<ScenarioName>([
  'native-peer-is-measured-not-asserted',
  'supervisor-death-enters-stale-reclaim',
  'lost-grant-idempotent-recovery',
  'daemon-restart-reconstructs-lease',
  'lease-scope-binds-machine-and-reaper',
  'request-id-is-durable-before-acquire',
  'same-request-recovery-precedes-peer-refusal',
]);

export async function runPr267Scenario(scenario: ScenarioName) {
  if (deferred.has(scenario)) {
    return runDeferredStartScenario(scenario as DeferredScenarioName);
  }
  if (lease.has(scenario)) {
    return runPr267LeaseScenario(scenario as Pr267LeaseScenarioName);
  }
  return runPr267ReaperScenario(scenario as Pr267ReaperScenarioName);
}
