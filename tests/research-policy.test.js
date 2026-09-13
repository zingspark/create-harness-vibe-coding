import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeHarnessTempRoot } from './support/temp-root.js';

const repoRoot = path.resolve('.');
const fixtureRoot = path.resolve('tests/fixtures/harness-092/project');
const script = path.resolve('Harness/scripts/research-policy.mjs');
const tempRoots = new Set();

function project(prefix = 'research-policy-') {
  const root = makeHarnessTempRoot(prefix);
  tempRoots.add(root);
  fs.cpSync(fixtureRoot, root, { recursive: true });
  fs.mkdirSync(path.join(root, 'Harness/tasks/research-task'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Harness/tasks/research-task/REFERENCES.md'), '# Research references\n', 'utf8');
  return root;
}

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function input(root, name, value) {
  const file = path.join(root, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  return file;
}

function run(root, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

function json(result) {
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    assert.fail(`expected JSON CLI output; status=${result.status}; stdout=${result.stdout}; stderr=${result.stderr}`);
  }
}

test('AC-01 simple chore without a trigger does not require web research or dependencies', () => {
  const root = project();
  const result = run(root, ['decide', '--task-type', 'chore', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = json(result);
  assert.equal(output.search, false);
  assert.ok(Array.isArray(output.reasons));
  assert.equal(output.addDependency, false);
});

test('AC-01 capability and volatility triggers require web research without auto-download', () => {
  const root = project();
  for (const trigger of ['capability-gap', 'volatile-api', 'user-request', 'repeated-failure', 'benchmark-gap']) {
    const result = run(root, ['decide', '--trigger', trigger, '--task-type', 'chore', '--json']);
    assert.equal(result.status, 0, `${trigger}: ${result.stderr || result.stdout}`);
    const output = json(result);
    assert.equal(output.search, true, trigger);
    assert.ok(output.reasons.length > 0, trigger);
    assert.equal(output.addDependency, false, trigger);
  }
});

test('AC-01 record --apply writes source-backed references into the task capsule', () => {
  const root = project();
  const file = input(root, 'reference', {
    url: 'https://example.com/official-harness-guide',
    title: 'Official Harness Guide',
    sourceType: 'official',
    version: '2026-09',
    license: 'CC-BY-4.0',
    decision: 'adapt',
    reason: 'Use the bounded-context idea with local contracts',
    acIds: ['AC-03', 'AC-04'],
    checkedAt: '2026-09-09T00:00:00Z',
  });
  const result = run(root, ['record', '--project', root, '--task', 'research-task', '--input', file, '--apply', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const references = fs.readFileSync(path.join(root, 'Harness/tasks/research-task/REFERENCES.md'), 'utf8');
  assert.match(references, /Official Harness Guide/);
  assert.match(references, /https:\/\/example\.com\/official-harness-guide/);
  assert.match(references, /adapt/);
  assert.match(references, /AC-03/);
});

test('AC-01 record without --apply is a dry run and preserves references', () => {
  const root = project();
  const target = path.join(root, 'Harness/tasks/research-task/REFERENCES.md');
  const before = fs.readFileSync(target, 'utf8');
  const file = input(root, 'reference-dry', {
    url: 'https://example.com/dry', title: 'Dry', sourceType: 'author', version: '1', license: 'MIT',
    decision: 'reject', reason: 'Not reusable', acIds: ['AC-01'], checkedAt: '2026-09-09T00:00:00Z',
  });
  const result = run(root, ['record', '--project', root, '--task', 'research-task', '--input', file, '--json']);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('AC-01 adopting a code dependency without a license is refused', () => {
  const root = project();
  const target = path.join(root, 'Harness/tasks/research-task/REFERENCES.md');
  const before = fs.readFileSync(target, 'utf8');
  const file = input(root, 'reference-no-license', {
    url: 'https://example.com/package', title: 'Unlicensed package', sourceType: 'official', version: '1.0.0', license: '',
    decision: 'adopt', reason: 'Would add a dependency', acIds: ['AC-05'], checkedAt: '2026-09-09T00:00:00Z',
  });
  const result = run(root, ['record', '--project', root, '--task', 'research-task', '--input', file, '--apply', '--json']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /license/i);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});
