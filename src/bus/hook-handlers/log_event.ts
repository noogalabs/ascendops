// Built-in handler: emits a follow-up bus event whose category/type/severity/meta come from hook.handler.
// Hardened against argv injection: validates registry-supplied category/type/severity before passing to execFile.
import { execFile } from 'child_process';
import { join } from 'path';
import type { HandlerFn } from '../hooks';
import type { EventCategory, EventSeverity } from '../../types/index';

const TYPE_REGEX = /^[a-z0-9_-]+$/;
const VALID_CATEGORIES: ReadonlySet<EventCategory> = new Set([
  'action', 'error', 'metric', 'milestone', 'heartbeat', 'message', 'task', 'approval', 'agent_activity',
]);
const VALID_SEVERITIES: ReadonlySet<EventSeverity> = new Set(['info', 'warning', 'error', 'critical']);

export const logEventHandler: HandlerFn = (hook, event) => {
  const rawCategory = hook.handler.category;
  const rawType = hook.handler.type;
  const rawSeverity = hook.handler.severity;

  const category: EventCategory =
    rawCategory && VALID_CATEGORIES.has(rawCategory) ? rawCategory : 'action';
  const type: string =
    typeof rawType === 'string' && TYPE_REGEX.test(rawType) ? rawType : 'hook_handler_log_event';
  const severity: EventSeverity =
    rawSeverity && VALID_SEVERITIES.has(rawSeverity) ? rawSeverity : 'info';

  const meta = {
    ...(hook.handler.meta ?? {}),
    source_hook_id: hook.id,
    source_event_id: event.id,
  };
  try {
    const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    if (frameworkRoot) {
      execFile(
        process.execPath,
        [join(frameworkRoot, 'dist', 'cli.js'), 'bus', 'log-event', category, type, severity, '--meta', JSON.stringify(meta)],
        { timeout: 5000 },
        () => {},
      );
    } else {
      execFile(
        'cortextos',
        ['bus', 'log-event', category, type, severity, '--meta', JSON.stringify(meta)],
        { timeout: 5000 },
        () => {},
      );
    }
  } catch { /* fire-and-forget */ }
  return { action: 'fire', reason: 'event_logged' };
};

export default logEventHandler;
