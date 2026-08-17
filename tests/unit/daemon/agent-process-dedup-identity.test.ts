import { describe, expect, it, vi } from 'vitest';
import { AgentProcess, type AgentInjectionOptions } from '../../../src/daemon/agent-process.js';
import { CodexAppServerPTY, type CodexTurnRouting } from '../../../src/pty/codex-app-server-pty.js';
import { MessageDedup } from '../../../src/pty/inject.js';

function runningProcess() {
  const process = Object.create(AgentProcess.prototype) as AgentProcess;
  const injectMessage = vi.fn();
  Object.assign(process, {
    dedup: new MessageDedup(),
    lastInjectedAt: 0,
    log: vi.fn(),
    name: 'alpha',
    pty: { injectMessage },
    status: 'running',
  });
  return { process, injectMessage };
}

describe('AgentProcess structured injection dedup identity', () => {
  it('releases the identity when cron queue admission throws before commit', () => {
    const { process } = runningProcess();
    const injectCronSequence = vi.fn()
      .mockImplementationOnce(() => { throw new Error('queue admission failed'); })
      .mockImplementationOnce(() => undefined);
    Object.assign(process, {
      pty: Object.assign(Object.create(CodexAppServerPTY.prototype), { injectCronSequence }),
    });
    const options: AgentInjectionOptions = {
      dedupIdentity: 'daemon-cron:heartbeat:fire-1',
      codexRouting: {
        model: 'gpt-5.6-terra',
        source: 'daemon-cron',
        cronName: 'heartbeat',
        reason: 'reviewed_mechanical_preflight',
      },
      codexContinuation: 'configured-Sol continuation',
      codexFallback: 'configured-Sol fallback',
    };

    expect(process.injectMessageDetailed('exact reviewed preflight', options)).toEqual({
      ok: false,
      code: 'ADMISSION_FAILED',
      message: 'inject for "alpha" failed before admission: queue admission failed',
    });
    expect(process.injectMessageDetailed('exact reviewed preflight', options)).toEqual({ ok: true });
    expect(process.injectMessageDetailed('exact reviewed preflight', options)).toMatchObject({
      ok: false,
      code: 'DEDUPED',
    });
    expect(injectCronSequence).toHaveBeenCalledTimes(2);
  });

  it('starts distinct Terra sequences for identical reviewed bytes from distinct daemon fires', () => {
    const { process } = runningProcess();
    const injectCronSequence = vi.fn();
    Object.assign(process, {
      pty: Object.assign(Object.create(CodexAppServerPTY.prototype), { injectCronSequence }),
    });
    const routing: CodexTurnRouting = {
      model: 'gpt-5.6-terra',
      source: 'daemon-cron',
      cronName: 'heartbeat',
      reason: 'reviewed_mechanical_preflight',
    };
    const common = {
      codexRouting: routing,
      codexContinuation: 'configured-Sol continuation',
      codexFallback: 'configured-Sol fallback',
    };
    const first: AgentInjectionOptions = { ...common, dedupIdentity: 'daemon-cron:heartbeat:fire-1' };
    const second: AgentInjectionOptions = { ...common, dedupIdentity: 'daemon-cron:heartbeat:fire-2' };

    expect(process.injectMessageDetailed('exact reviewed preflight', first)).toEqual({ ok: true });
    expect(process.injectMessageDetailed('exact reviewed preflight', second)).toEqual({ ok: true });
    expect(injectCronSequence).toHaveBeenCalledTimes(2);
    expect(injectCronSequence).toHaveBeenNthCalledWith(
      1,
      'exact reviewed preflight',
      routing,
      'configured-Sol continuation',
      'configured-Sol fallback',
    );
    expect(injectCronSequence).toHaveBeenNthCalledWith(
      2,
      'exact reviewed preflight',
      routing,
      'configured-Sol continuation',
      'configured-Sol fallback',
    );
  });

  it('still dedupes a retry of the same structured fire identity', () => {
    const { process, injectMessage } = runningProcess();
    const options: AgentInjectionOptions = { dedupIdentity: 'daemon-cron:heartbeat:fire-1' };

    expect(process.injectMessageDetailed('exact reviewed preflight', options)).toEqual({ ok: true });
    expect(process.injectMessageDetailed('exact reviewed preflight', options)).toMatchObject({
      ok: false,
      code: 'DEDUPED',
    });
    expect(injectMessage).toHaveBeenCalledTimes(1);
  });

  it('continues to dedupe identical ordinary message content', () => {
    const { process, injectMessage } = runningProcess();

    expect(process.injectMessageDetailed('ordinary message')).toEqual({ ok: true });
    expect(process.injectMessageDetailed('ordinary message')).toMatchObject({
      ok: false,
      code: 'DEDUPED',
    });
    expect(injectMessage).toHaveBeenCalledTimes(1);
  });

  it('does not let ordinary content pre-seed a daemon structured identity', () => {
    const { process } = runningProcess();
    const injectCronSequence = vi.fn();
    const injectMessage = vi.fn();
    Object.assign(process, {
      pty: Object.assign(Object.create(CodexAppServerPTY.prototype), {
        injectCronSequence,
        injectMessage,
      }),
    });
    const identity = 'daemon-cron:heartbeat:fire-1';
    const options: AgentInjectionOptions = {
      dedupIdentity: identity,
      codexRouting: {
        model: 'gpt-5.6-terra',
        source: 'daemon-cron',
        cronName: 'heartbeat',
        reason: 'reviewed_mechanical_preflight',
      },
      codexContinuation: 'configured-Sol continuation',
      codexFallback: 'configured-Sol fallback',
    };

    expect(process.injectMessageDetailed(identity)).toEqual({ ok: true });
    expect(process.injectMessageDetailed('exact reviewed preflight', options)).toEqual({ ok: true });
    expect(process.injectMessageDetailed('exact reviewed preflight', options)).toMatchObject({
      ok: false,
      code: 'DEDUPED',
      dedupIdentity: identity,
    });
    expect(injectMessage).toHaveBeenCalledTimes(1);
    expect(injectCronSequence).toHaveBeenCalledTimes(1);
  });

  it('retains an admitted structured identity across ordinary FIFO churn', () => {
    const { process } = runningProcess();
    const injectCronSequence = vi.fn();
    const injectMessage = vi.fn();
    Object.assign(process, {
      pty: Object.assign(Object.create(CodexAppServerPTY.prototype), {
        injectCronSequence,
        injectMessage,
      }),
    });
    const identity = 'daemon-cron:heartbeat:fire-1';
    const options: AgentInjectionOptions = {
      dedupIdentity: identity,
      codexRouting: {
        model: 'gpt-5.6-terra',
        source: 'daemon-cron',
        cronName: 'heartbeat',
        reason: 'reviewed_mechanical_preflight',
      },
      codexContinuation: 'configured-Sol continuation',
      codexFallback: 'configured-Sol fallback',
    };

    expect(process.injectMessageDetailed('exact reviewed preflight', options)).toEqual({ ok: true });
    for (let i = 0; i < 100; i += 1) {
      expect(process.injectMessageDetailed(`ordinary-${i}`)).toEqual({ ok: true });
    }
    expect(process.injectMessageDetailed('exact reviewed preflight', options)).toMatchObject({
      ok: false,
      code: 'DEDUPED',
      dedupIdentity: identity,
    });
    expect(injectCronSequence).toHaveBeenCalledTimes(1);
    expect(injectMessage).toHaveBeenCalledTimes(100);
  });
});
