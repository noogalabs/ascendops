/**
 * dashboard/src/app/api/media/__tests__/media-route.test.ts
 *
 * Security regression tests for GET /api/media/[...filepath]:
 *   1. Credential exfil: .env / .env.* / secrets* / dotfiles / key material
 *      must never be served, even when they resolve under an allowed root.
 *      The denylist must hold on the RESOLVED basename (symlink-safe).
 *   2. Stored XSS: .html/.htm must not be served inline as executable
 *      text/html on the dashboard origin (text/plain + nosniff + CSP sandbox).
 *   3. Legit behavior preserved: images inline, raw md as text/plain,
 *      ?render=true md sanitization path, files inside dot-directories.
 *
 * Uses the route handler directly with a tmp CTX_ROOT set before import
 * (same pattern as health-route.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const isWindows = process.platform === 'win32';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Global setup — env must be set before the route (and @/lib/config) loads.
// ---------------------------------------------------------------------------

const ctxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-route-test-ctx-'));
const fwRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-route-test-fw-'));
process.env.CTX_ROOT = ctxRoot;
process.env.CTX_FRAMEWORK_ROOT = fwRoot;

function write(rel: string, content: string | Buffer): string {
  const full = path.join(ctxRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

beforeAll(() => {
  // Credential-class files under an allowed root (the exfil targets)
  write('orgs/demo/agents/dane/.env', 'BOT_TOKEN=tg-secret-token\nCHAT_ID=12345\n');
  write('media/.env.local', 'API_KEY=leakme\n');
  write('media/secrets.json', '{"k":"v"}');
  write('media/server.pem', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n');
  write('media/signing.key', 'raw-key-bytes');

  // Symlink with an innocent media name pointing at the .env (bypass attempt)
  // Symlinks require Developer Mode on Windows; skip creation when unavailable.
  if (!isWindows) {
    fs.symlinkSync(
      path.join(ctxRoot, 'orgs/demo/agents/dane/.env'),
      path.join(ctxRoot, 'media/avatar.png'),
    );
  }

  // Legit files
  write('media/pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  write('media/page.html', '<html><body><script>document.title=document.cookie</script>hi</body></html>');
  write('media/notes.md', '# Title\n\n<script>alert(1)</script>\n\nbody text\n');
  write('.claude/skills/demo/SKILL.md', '# A skill\n');
});

afterAll(() => {
  fs.rmSync(ctxRoot, { recursive: true, force: true });
  fs.rmSync(fwRoot, { recursive: true, force: true });
});

// Dynamic import so CTX_ROOT is set before module init
let GET: (req: NextRequest, ctx: { params: Promise<{ filepath: string[] }> }) => Promise<Response>;
const mod = await import('../[...filepath]/route');
GET = mod.GET;

function call(rel: string, query = ''): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/media/${rel}${query}`);
  return GET(req, { params: Promise.resolve({ filepath: rel.split('/') }) });
}

// ---------------------------------------------------------------------------
// 1. Credential exfil denylist
// ---------------------------------------------------------------------------

describe('GET /api/media — sensitive-file denylist', () => {
  it('refuses to serve an agent .env file', async () => {
    const res = await call('orgs/demo/agents/dane/.env');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not_found');
  });

  it('refuses .env.* variants', async () => {
    const res = await call('media/.env.local');
    expect(res.status).toBe(404);
  });

  it('refuses secrets* files', async () => {
    const res = await call('media/secrets.json');
    expect(res.status).toBe(404);
  });

  it('refuses key material by extension (.pem, .key)', async () => {
    expect((await call('media/server.pem')).status).toBe(404);
    expect((await call('media/signing.key')).status).toBe(404);
  });

  it('blocks symlinks whose resolved basename is sensitive (bypass-safe)', async () => {
    // avatar.png -> .env; realpath resolution must expose the true basename
    const res = await call('media/avatar.png');
    expect(res.status).toBe(404);
  });

  it('still serves normal files inside dot-directories (only basename is checked)', async () => {
    const res = await call('.claude/skills/demo/SKILL.md');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('# A skill');
  });
});

// ---------------------------------------------------------------------------
// 2. HTML stored-XSS hardening
// ---------------------------------------------------------------------------

describe('GET /api/media — HTML is never executable on the dashboard origin', () => {
  it('serves .html as text/plain with nosniff and CSP sandbox', async () => {
    const res = await call('media/page.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(res.headers.get('Content-Type')).not.toContain('text/html');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox');
    // Body is intact — the preview iframe (srcDoc, sandboxed) still works
    expect(await res.text()).toContain('<script>');
  });
});

// ---------------------------------------------------------------------------
// 3. Legit media behavior preserved
// ---------------------------------------------------------------------------

describe('GET /api/media — legit serving preserved', () => {
  it('serves images inline with the right MIME type', async () => {
    const res = await call('media/pic.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Disposition')).toContain('inline');
  });

  it('serves raw markdown as text/plain', async () => {
    const res = await call('media/notes.md');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
  });

  it('?render=true markdown path still returns sanitized HTML', async () => {
    const res = await call('media/notes.md', '?render=true');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Title');
    expect(html).not.toContain('<script>');
  });

  it('returns 404 for files that do not exist', async () => {
    const res = await call('media/nope.png');
    expect(res.status).toBe(404);
  });
});
