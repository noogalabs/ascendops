import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repositoryRoot, 'dist', 'cli.js');
const packageMetadata = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
const schemas = new Map();
const ajv = new Ajv({ allErrors: true, strict: true });

function validator(name) {
  if (!schemas.has(name)) {
    const schema = JSON.parse(readFileSync(join(repositoryRoot, 'schemas', name), 'utf8'));
    schemas.set(name, ajv.compile(schema));
  }
  return schemas.get(name);
}

function run(args, home, frameworkRoot) {
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  delete environment.CTX_INSTANCE_ID;
  delete environment.CTX_ROOT;
  delete environment.CTX_PROJECT_ROOT;
  if (frameworkRoot) environment.CTX_FRAMEWORK_ROOT = frameworkRoot;
  else delete environment.CTX_FRAMEWORK_ROOT;
  return spawnSync(process.execPath, [cliPath, 'lifecycle', 'status', ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment,
    timeout: 10_000,
  });
}

function expectJsonRun(result, exitCode, schemaName, expectedCode) {
  if (result.status !== exitCode) {
    throw new Error(
      `expected exit ${exitCode}, received ${result.status}: ${result.stderr}\n${result.stdout}`,
    );
  }
  if (result.stderr !== '') throw new Error(`unexpected stderr: ${result.stderr}`);
  const document = JSON.parse(result.stdout);
  const validate = validator(schemaName);
  if (!validate(document)) throw new Error(JSON.stringify(validate.errors));
  if (expectedCode && document.error?.code !== expectedCode) {
    throw new Error(`expected ${expectedCode}, received ${document.error?.code}`);
  }
  return document;
}

const root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cx-ls-'));
try {
  const instanceId = `verify_${randomUUID().replaceAll('-', '')}`;
  if (process.platform === 'win32') {
    const pipeName = `cortextos-${instanceId}`;
    if (readdirSync('\\\\.\\pipe\\').includes(pipeName)) {
      throw new Error('random verifier pipe unexpectedly exists');
    }
  }
  const home = join(root, 'home');
  const frameworkRoot = join(root, 'framework');
  mkdirSync(join(home, '.cortextos', instanceId, 'state'), { recursive: true });
  mkdirSync(frameworkRoot, { recursive: true });
  writeFileSync(
    join(frameworkRoot, 'package.json'),
    `${JSON.stringify({ name: 'cortextos', version: packageMetadata.version })}\n`,
    'utf8',
  );

  const local = expectJsonRun(
    run(['--instance', instanceId, '--json', '--contract', 'cortext.status/v1'], home, frameworkRoot),
    0,
    'cortext.status.v1.schema.json',
  );
  if (local.snapshot_status !== 'complete' || local.runtime?.daemon?.status !== 'stopped') {
    throw new Error('CLI fixture preconditions are not platform-stable');
  }
  expectJsonRun(
    run([
      '--instance', instanceId, '--json', '--redact',
      '--contract', 'cortext.status.redacted/v1',
    ], home, frameworkRoot),
    0,
    'cortext.status.redacted.v1.schema.json',
  );
  const usable = expectJsonRun(
    run(['--instance', instanceId, '--json', '--check', 'usable@v1'], home, frameworkRoot),
    0,
    'cortext.status.v1.schema.json',
  );
  if (usable.check?.result !== 'pass') throw new Error('usable@v1 did not pass');
  const healthy = expectJsonRun(
    run(['--instance', instanceId, '--json', '--check', 'healthy@v1'], home, frameworkRoot),
    1,
    'cortext.status.v1.schema.json',
  );
  if (healthy.check?.result !== 'fail') throw new Error('healthy@v1 did not fail');
  expectJsonRun(
    run(['--instance', instanceId, '--json', '--redact', '--paths'], home, frameworkRoot),
    2,
    'cortext.status.redacted.error.v1.schema.json',
    'CORTEXT_STATUS_INVALID_OPTION_COMBINATION',
  );

  const brokenHome = join(root, 'broken-home');
  mkdirSync(brokenHome, { recursive: true });
  writeFileSync(join(brokenHome, '.cortextos'), 'not a directory', 'utf8');
  expectJsonRun(
    run(['--json'], brokenHome),
    3,
    'cortext.status.error.v1.schema.json',
    'CORTEXT_STATUS_COLLECTION_FAILED',
  );
  expectJsonRun(
    run(['--instance', instanceId, '--json', '--redact', '--check', 'unknown@v1'], home, frameworkRoot),
    4,
    'cortext.status.redacted.error.v1.schema.json',
    'CORTEXT_STATUS_UNSUPPORTED_CHECK_POLICY',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
