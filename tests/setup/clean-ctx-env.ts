import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CTX_TEST_REAL_HOME ??= process.env.HOME ?? homedir();
const testHome = mkdtempSync(join(tmpdir(), 'ctx-test-home-'));
process.env.HOME = testHome;
if (process.platform === 'win32') {
  process.env.USERPROFILE = testHome;
}

delete process.env.CORTEXTOS_DIR;
delete process.env.CTX_AGENT_DIR;
delete process.env.CTX_PROJECT_ROOT;
delete process.env.CTX_FRAMEWORK_ROOT;
delete process.env.CTX_AGENT_NAME;
delete process.env.CTX_ORG;
delete process.env.CTX_INSTANCE_ID;
delete process.env.CTX_ROOT;

// Runtime identity is install-configured. Tests that exercise production
// entries get an explicit fixture identity instead of borrowing the removed
// production literals; missing/blank contract tests pass their own env map.
process.env.ADMIN_USERNAME = 'test-owner';
