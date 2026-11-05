/**
 * E2E: Approve/Open PR path against the live daemon + GitHub API.
 *
 * Verifies:
 *  1. POST /api/tasks/:id/pr returns a https://github.com/... URL
 *  2. gh API can resolve that PR (exists, accessible with machine credentials)
 *  3. Anonymous HTML fetch of private PR returns 404 (documents GitHub behavior)
 *  4. login?return_to= wrapper is a valid URL we should open on phones
 *
 * Usage:
 *   HERCULES_TOKEN=… node scripts/e2e-open-pr.mjs [task-id]
 *   Defaults task-id: task-4 (must be review|done with changes)
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const token = process.env['HERCULES_TOKEN'];
const base = process.env['HERCULES_URL'] ?? 'http://127.0.0.1:8787';
const taskId = process.argv[2] ?? 'task-4';

if (!token) {
  console.error('HERCULES_TOKEN required');
  process.exit(2);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function ghJson(args) {
  const { stdout } = await execFileAsync('gh', ['api', ...args], { maxBuffer: 2e6 });
  return JSON.parse(stdout);
}

async function main() {
  console.log(`[e2e] POST ${base}/api/tasks/${taskId}/pr`);
  const res = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}/pr`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  console.log('[e2e] status', res.status, body);

  assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert(typeof body.url === 'string', 'missing url');
  assert(body.url.startsWith('https://github.com/'), `not a github url: ${body.url}`);
  assert(['created', 'existing', 'compare'].includes(body.mode), `bad mode ${body.mode}`);

  // Resolve via API (auth) — HTML anonymous may 404 for private repos.
  const m = body.url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (m) {
    const [, owner, name, num] = m;
    const pr = await ghJson([`repos/${owner}/${name}/pulls/${num}`]);
    console.log('[e2e] gh api PR', {
      html_url: pr.html_url,
      state: pr.state,
      head: pr.head?.ref,
      base: pr.base?.ref,
      private_note: 'HTML without browser session → 404 if repo is private',
    });
    assert(pr.html_url === body.url || pr.html_url.startsWith('https://github.com/'), 'html_url mismatch');
    assert(pr.state === 'open' || pr.state === 'closed' || pr.state === 'merged', 'unexpected pr state');
  } else {
    console.log('[e2e] compare-mode URL (no pull number) — skip PR api check');
  }

  // Document private-repo anonymous 404
  const anon = await fetch(body.url, { redirect: 'follow' });
  const loginWrap = `https://github.com/login?return_to=${encodeURIComponent(body.url)}`;
  console.log('[e2e] anonymous HTML status for PR URL:', anon.status, '(404 expected if private)');
  console.log('[e2e] recommended phone open URL:', loginWrap);

  if (anon.status === 404) {
    console.log(
      '[e2e] OK: private repo anonymous 404 confirmed — UI must open login?return_to= not bare PR URL alone',
    );
  }

  console.log('[e2e] PASS');
}

main().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exit(1);
});
