import { afterEach, describe, expect, it, vi } from 'vitest';
import { displayStatuses } from '../../../src/cli/status.js';
import type { AgentStatus } from '../../../src/types/index.js';

function capture(statuses: AgentStatus[]): string {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  displayStatuses(statuses);
  return log.mock.calls.map((args) => args.join(' ')).join('\n');
}

describe('status model and first-run labels', () => {
  afterEach(() => vi.restoreAllMocks());

  it('labels an unset model as default', () => {
    expect(capture([{ name: 'alice', status: 'running', pid: 12, uptime: 42 }])).toContain('default');
  });

  it('keeps an explicit model verbatim', () => {
    const output = capture([{ name: 'alice', status: 'running', model: 'gpt-5.6-sol' }]);
    expect(output).toContain('gpt-5.6-sol');
    expect(output).not.toContain('default');
  });

  it('marks a wedged first-run prompt unhealthy', () => {
    const output = capture([{ name: 'alice', status: 'running', awaitingConfirmation: true }]);
    expect(output).toContain('unhealthy*');
    expect(output).toContain('awaiting interactive confirmation');
  });
});
