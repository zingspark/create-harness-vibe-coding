import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeHarnessTempRoot } from './support/temp-root.js';

const repoRoot = path.resolve('.');
const fixtureRoot = path.resolve('tests/fixtures/harness-092/project');
const script = path.resolve('Harness/scripts/memory-context.mjs');
const tempRoots = new Set();

function project(prefix = 'memory-context-') {
  const root = makeHarnessTempRoot(prefix);
  tempRoots.add(root);
  fs.cpSync(fixtureRoot, root, { recursive: true });
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

function candidate(overrides = {}) {
  return {
    id: 'memory-method-new',
    kind: 'method',
    scope: 'project',
    when: 'bounded context tests run',
    rule: 'Use evidence pointers and bounded packs',
    avoid: 'Do not inject raw logs',
    signals: ['context', 'budget'],
    evidenceRefs: ['E-candidate'],
    counterexample: { scenario: 'A task has no matching memory', outcome: 'Use the task fallback' },
    verification: { status: 'passed', method: 'AC-04 integration test', evidenceRef: 'E-candidate' },
    status: 'active',
    ...overrides,
  };
}

test('AC-04 query returns metadata-backed hits with explainable fields and byte budget', () => {
  const root = project();
  const result = run(root, ['query', '--project', root, '--text', 'context packing budget', '--scope', 'project', '--top-k', '5', '--budget-bytes', '1200', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = json(result);
  assert.ok(Array.isArray(output.hits));
  const hit = output.hits.find(item => item.id === 'memory-method-1');
  assert.ok(hit);
  for (const field of ['id', 'rule', 'reason', 'path']) assert.equal(typeof hit[field], 'string');
  assert.ok(Array.isArray(output.skipped));
  assert.ok(output.budget.usedBytes <= output.budget.limitBytes);
});

test('AC-04 legacy memory without metadata remains queryable without verified status', () => {
  const root = project();
  const result = run(root, ['query', '--project', root, '--text', 'historical rule', '--scope', 'project', '--top-k', '5', '--budget-bytes', '2000', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = json(result);
  const hit = output.hits.find(item => item.rule?.includes('historical rule'));
  assert.ok(hit);
  assert.notEqual(hit.status, 'verified');
  assert.notEqual(hit.verified, true);
});

test('AC-04 query skips superseded memory and reports why', () => {
  const root = project();
  const result = run(root, ['query', '--project', root, '--text', 'old context path', '--scope', 'project', '--top-k', '10', '--budget-bytes', '2000', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = json(result);
  assert.equal(output.hits.some(item => item.id === 'memory-method-old'), false);
  assert.ok(output.skipped.some(item => item.id === 'memory-method-old' && /superseded/i.test(item.reason)));
});

test('AC-04 validate rejects a method candidate lacking evidence, counterexample, or verification', () => {
  const root = project();
  const file = input(root, 'invalid-candidate', candidate({ evidenceRefs: [], counterexample: null, verification: null }));
  const result = run(root, ['validate', '--project', root, '--input', file, '--json']);
  const output = json(result);
  assert.equal(output.valid ?? output.ok, false);
  assert.match(JSON.stringify(output), /evidence|counterexample|verif/i);
});

test('AC-04 apply requires --apply and does not mutate memory in dry mode', () => {
  const root = project();
  const file = input(root, 'candidate-dry', candidate());
  const target = path.join(root, 'Harness/memory/agent-lessons-patterns.md');
  const before = fs.readFileSync(target, 'utf8');
  const result = run(root, ['apply', '--project', root, '--input', file, '--json']);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('AC-04 apply writes a validated method next to existing When bullets and deduplicates by id', () => {
  const root = project();
  const file = input(root, 'candidate-apply', candidate());
  const args = ['apply', '--project', root, '--input', file, '--apply', '--json'];
  const first = run(root, args);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const target = path.join(root, 'Harness/memory/agent-lessons-patterns.md');
  const once = fs.readFileSync(target, 'utf8');
  const second = run(root, args);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const twice = fs.readFileSync(target, 'utf8');
  assert.equal((twice.match(/memory-method-new/g) ?? []).length, 1);
  assert.match(twice, /When legacy memory bullet/);
  assert.equal(twice, once);
});

test('AC-04 apply rejects conflicting content without an explicit supersedes relation', () => {
  const root = project();
  const file = input(root, 'candidate-conflict', candidate({ id: 'memory-method-1', rule: 'Replace the bounded-pack rule with a conflicting rule' }));
  const result = run(root, ['apply', '--project', root, '--input', file, '--apply', '--json']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /conflict|supersed/i);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'Harness/memory/agent-lessons-patterns.md'), 'utf8'), /Replace the bounded-pack rule/);
});

test('AC-04 set-status preserves memory and supports reversible inactive state', () => {
  const root = project();
  const target = path.join(root, 'Harness/memory/agent-lessons-patterns.md');
  const before = fs.readFileSync(target, 'utf8');
  const result = run(root, ['set-status', '--project', root, '--id', 'memory-method-1', '--status', 'inactive', '--apply', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const after = fs.readFileSync(target, 'utf8');
  assert.match(after, /memory-method-1/);
  assert.notEqual(after, before);
  assert.match(after, /"status"\s*:\s*"inactive"/);
  const restore = run(root, ['set-status', '--project', root, '--id', 'memory-method-1', '--status', 'active', '--apply', '--json']);
  assert.equal(restore.status, 0, restore.stderr || restore.stdout);
  assert.match(fs.readFileSync(target, 'utf8'), /"status"\s*:\s*"active"/);
});

test('AC-04 feedback writes task-local evidence without changing global memory', () => {
  const root = project();
  const target = path.join(root, 'Harness/memory/agent-lessons-patterns.md');
  const before = fs.readFileSync(target, 'utf8');
  const result = run(root, ['feedback', '--project', root, '--task', 'task-context-fixture', '--entry', 'memory-method-1', '--outcome', 'useful', '--reason', 'Pack omitted raw log body as required', '--apply', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  const taskRoot = path.join(root, 'Harness/tasks/task-context-fixture');
  const files = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, entry.name); if (entry.isDirectory()) walk(p); else files.push(p); } };
  walk(taskRoot);
  assert.ok(files.some(file => /feedback|evidence/i.test(path.basename(file)) && /Pack omitted raw log body/.test(fs.readFileSync(file, 'utf8'))));
});
