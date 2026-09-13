// Backend ensure contract (AC-06 / AC-07).
// This is a black-box CLI test: it starts the real test server and never
// imports or mocks server internals.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeHarnessTempRoot } from './support/temp-root.js';

const repoRoot = path.resolve('.');
const controlCli = path.join(repoRoot, 'Harness', 'scripts', 'wf-ui-control.mjs');
const liveServers = new Map();
const roots = new Set();

function tempProject(label) {
  const root = makeHarnessTempRoot(`harness-ensure-${label}-`);
  fs.mkdirSync(path.join(root, 'Harness', 'tasks'), { recursive: true });
  roots.add(root);
  return root;
}

function parseJsonOutput(stdout) {
  const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error(`ensure-backend did not return JSON: ${stdout}`);
}

function runEnsure(projectRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      controlCli, 'ensure-backend', '--project', projectRoot,
      '--port', '0', '--no-open', '--json',
    ], {
      cwd: repoRoot,
      env: { ...process.env, BROWSER: 'false', NO_BROWSER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`ensure-backend timed out: ${stderr}`));
    }, 20_000);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ensure-backend exited ${code}: ${stdout}\n${stderr}`));
        return;
      }
      try {
        const result = parseJsonOutput(stdout);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.ok(result.url, `ensure result must include url: ${stdout}`);
        assert.ok(result.pid, `ensure result must include pid: ${stdout}`);
        assert.equal(result.projectRoot, path.resolve(projectRoot));
        assert.equal(result.openBrowser, false, 'ensure must not open a browser');
        liveServers.set(Number(result.pid), result);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function health(url) {
  const response = await fetch(new URL('/api/health', url));
  return { status: response.status, body: await response.json() };
}

function stopOwnedServer(result) {
  const pid = Number(result?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('close', resolve);
      killer.once('error', resolve);
    });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    return Promise.resolve();
  }
}

afterEach(async () => {
  await Promise.all([...liveServers.values()].map(stopOwnedServer));
  liveServers.clear();
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
  }
  roots.clear();
});

test('AC-06 ensure-backend cold-starts real server without a browser', async () => {
  const root = tempProject('cold');
  const result = await runEnsure(root);
  const checked = await health(result.url);
  assert.equal(checked.status, 200);
  assert.equal(checked.body.status, 'ok');
});

test('AC-06 concurrent ensure for one project reuses one backend', async () => {
  const root = tempProject('same');
  const [left, right] = await Promise.all([runEnsure(root), runEnsure(root)]);
  assert.equal(left.projectRoot, right.projectRoot);
  assert.equal(left.url, right.url, 'same project must receive one canonical backend URL');
  assert.equal(Number(left.pid), Number(right.pid), 'same project must reuse one server PID');
  assert.equal((await health(left.url)).status, 200);
});

test('AC-06 ensure never reuses a backend belonging to another project', async () => {
  const firstRoot = tempProject('one');
  const secondRoot = tempProject('two');
  const first = await runEnsure(firstRoot);
  const second = await runEnsure(secondRoot);
  assert.notEqual(first.projectRoot, second.projectRoot);
  assert.notEqual(first.url, second.url, 'different projects must not share a backend URL');
  assert.notEqual(Number(first.pid), Number(second.pid), 'different projects must not share a server PID');
  assert.equal((await health(first.url)).status, 200);
  assert.equal((await health(second.url)).status, 200);
});
