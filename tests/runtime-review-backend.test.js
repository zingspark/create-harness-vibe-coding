// Independent AC-06/07 boundary probe: lexical project aliases must not create
// two backends for one physical project. This intentionally stays black-box.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeHarnessTempRoot } from './support/temp-root.js';

const repoRoot = path.resolve('.');
const controlCli = path.join(repoRoot, 'Harness', 'scripts', 'wf-ui-control.mjs');
const owned = new Map();
const roots = new Set();

function parseJsonOutput(stdout) {
  const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error(`ensure-backend did not return JSON: ${stdout}`);
}

function ensure(projectRoot) {
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
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ensure-backend exited ${code}: ${stdout}\n${stderr}`));
        return;
      }
      try {
        let result;
        try {
          result = parseJsonOutput(stdout);
        } catch (error) {
          error.message += `\nproject: ${projectRoot}\nstderr: ${stderr}\nexit: ${code} signal: ${signal}`;
          throw error;
        }
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.ok(result.url, JSON.stringify(result));
        assert.ok(result.pid, JSON.stringify(result));
        owned.set(Number(result.pid), result);
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

function stopOwned(result) {
  const pid = Number(result?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
      killer.once('close', resolve);
      killer.once('error', resolve);
    });
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
  return Promise.resolve();
}

afterEach(async () => {
  await Promise.all([...owned.values()].map(stopOwned));
  owned.clear();
  for (const root of roots) {
    const resolved = path.resolve(root);
    const allowed = path.resolve('Harness', '.temp') + path.sep;
    assert.ok(resolved.startsWith(allowed), `refusing to remove non-temp root: ${root}`);
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
  }
  roots.clear();
});

test('AC-06 one physical project through a symlink alias reuses one backend', async () => {
  const root = makeHarnessTempRoot('runtime-review-backend-');
  roots.add(root);
  fs.mkdirSync(path.join(root, 'Harness', 'tasks'), { recursive: true });
  const alias = `${root}-alias`;
  roots.add(alias);
  try {
    fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    throw new Error(`symlink fixture unavailable: ${error.code || error.message}`);
  }

  const [physical, linked] = await Promise.all([ensure(root), ensure(alias)]);
  assert.equal(physical.url, linked.url,
    `one physical project must not start two backends: ${JSON.stringify({ physical, linked })}`);
  assert.equal(Number(physical.pid), Number(linked.pid),
    `one physical project must not start two PIDs: ${JSON.stringify({ physical, linked })}`);
});
