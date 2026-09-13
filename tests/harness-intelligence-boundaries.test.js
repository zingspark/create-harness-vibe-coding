import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeHarnessTempRoot } from './support/temp-root.js';

const repoRoot = path.resolve('.');
const fixtureRoot = path.resolve('tests/fixtures/harness-092/boundary-project');
const globalFixtureRoot = path.resolve('tests/fixtures/harness-092/boundary-global');
const taskContext = path.resolve('Harness/scripts/task-context.mjs');
const memoryContext = path.resolve('Harness/scripts/memory-context.mjs');
const researchPolicy = path.resolve('Harness/scripts/research-policy.mjs');
const roots = new Set();

function project(prefix = 'harness-boundary-') {
  const root = makeHarnessTempRoot(prefix);
  roots.add(root);
  fs.cpSync(fixtureRoot, root, { recursive: true });
  return root;
}

function globalRoot(prefix = 'harness-boundary-global-') {
  const root = makeHarnessTempRoot(prefix);
  roots.add(root);
  fs.cpSync(globalFixtureRoot, root, { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function run(script, root, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  let output = null;
  try { output = JSON.parse(result.stdout.trim()); } catch {}
  return { ...result, output };
}

function writeJson(root, name, value) {
  const file = path.join(root, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
  return file;
}

function validReference(overrides = {}) {
  return {
    url: 'https://example.com/boundary-source',
    title: 'Boundary source',
    sourceType: 'official',
    version: '2026.09',
    license: 'MIT',
    decision: 'adapt',
    reason: 'Use only the bounded evidence pattern',
    acIds: ['AC-04'],
    checkedAt: '2026-09-09T00:00:00Z',
    ...overrides,
  };
}

function validMethod(id, scope = 'project') {
  return {
    id,
    kind: 'method',
    scope,
    when: `${id} scenario`,
    rule: `${id} rule`,
    avoid: 'Do not over-apply a sample',
    signals: ['boundary'],
    evidenceRefs: ['E-boundary'],
    counterexample: { scenario: 'No matching evidence', outcome: 'Stop and report' },
    verification: { status: 'passed', method: 'AC boundary test', evidenceRef: 'E-boundary' },
    status: 'active',
  };
}

function linkOutsideProject(root, files) {
  const outside = makeHarnessTempRoot('harness-boundary-outside-');
  roots.add(outside);
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(outside, name), `${JSON.stringify(value)}\n`, 'utf8');
  const link = path.join(root, 'outside-link');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch {
    try { fs.symlinkSync(outside, link, 'dir'); } catch { return null; }
  }
  return { outside, input: name => path.join(link, name) };
}

test('AC-02/AC-03/AC-04 project input paths reject junctions that resolve outside project', (t) => {
  const root = project('harness-boundary-input-');
  const link = linkOutsideProject(root, {
    task: { nextAction: 'OUTSIDE_SECRET_SENTINEL' },
    memory: validMethod('outside-memory-input'),
    research: validReference({ url: 'https://example.com/outside-input' }),
  });
  if (!link) {
    t.skip('directory symlinks are unavailable on this platform');
    return;
  }

  const task = run(taskContext, root, [
    'pack', 'boundary-task', '--project', root, '--role', 'verifier',
    '--budget-bytes', '10000', '--input', link.input('task'), '--json',
  ]);
  assert.notEqual(task.status, 0, task.stdout);
  assert.doesNotMatch(task.stdout, /OUTSIDE_SECRET_SENTINEL/);

  const memory = run(memoryContext, root, [
    'validate', '--project', root, '--input', link.input('memory'), '--json',
  ]);
  assert.notEqual(memory.status, 0, memory.stdout);

  const referencesPath = path.join(root, 'Harness/tasks/boundary-task/REFERENCES.md');
  const before = fs.readFileSync(referencesPath, 'utf8');
  const research = run(researchPolicy, root, [
    'record', '--project', root, '--task', 'boundary-task', '--input', link.input('research'), '--apply', '--json',
  ]);
  assert.notEqual(research.status, 0, research.stdout);
  assert.equal(fs.readFileSync(referencesPath, 'utf8'), before);
});

test('AC-04 feedback and research record reject task ids outside Harness/tasks', () => {
  const root = project('harness-boundary-taskid-');
  const feedbackTarget = path.join(root, 'Harness/memory/evidence/memory-feedback.md');
  const feedback = run(memoryContext, root, [
    'feedback', '--project', root, '--task', '../memory', '--entry', 'boundary-method',
    '--outcome', 'useful', '--reason', 'TASK_TRAVERSAL_SENTINEL', '--apply', '--json',
  ]);
  assert.notEqual(feedback.status, 0, feedback.stdout);
  assert.equal(fs.existsSync(feedbackTarget), false);

  const projectReferences = path.join(root, 'Harness/memory/REFERENCES.md');
  assert.equal(fs.existsSync(projectReferences), false);
  const research = run(researchPolicy, root, [
    'record', '--project', root, '--task', '../memory', '--input', writeJson(root, 'safe-reference', validReference()), '--apply', '--json',
  ]);
  assert.notEqual(research.status, 0, research.stdout);
  assert.equal(fs.existsSync(projectReferences), false);
});

test('AC-03 update preserves role/workItem metadata and excludes non-applicable entries from pack', () => {
  const root = project('harness-boundary-applicability-');
  const roleInput = writeJson(root, 'role-context', {
    context: {
      facts: [{
        id: 'role-only-fact',
        text: 'ROLE_WORKITEM_SENTINEL',
        source: 'boundary fixture',
        status: 'verified',
        roles: ['verifier'],
        workItems: ['W-ONLY'],
      }],
    },
    nextAction: 'Run role applicability check',
  });
  const update = run(taskContext, root, [
    'update', 'boundary-task', '--project', root, '--input', roleInput, '--apply', '--json',
  ]);
  assert.equal(update.status, 0, update.stdout);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'Harness/tasks/boundary-task/STATE.json'), 'utf8'));
  const fact = state.context.facts.find(item => item.id === 'role-only-fact');
  assert.deepEqual(fact.roles, ['verifier']);
  assert.deepEqual(fact.workItems, ['W-ONLY']);

  const mismatch = run(taskContext, root, [
    'pack', 'boundary-task', '--project', root, '--role', 'developer', '--work-item', 'W-OTHER', '--budget-bytes', '10000', '--json',
  ]);
  assert.equal(mismatch.status, 0, mismatch.stdout);
  assert.doesNotMatch(mismatch.output.pack, /ROLE_WORKITEM_SENTINEL/);

  const match = run(taskContext, root, [
    'pack', 'boundary-task', '--project', root, '--role', 'verifier', '--work-item', 'W-ONLY', '--budget-bytes', '10000', '--json',
  ]);
  assert.equal(match.status, 0, match.stdout);
  assert.match(match.output.pack, /ROLE_WORKITEM_SENTINEL/);
});

test('AC-04 global memory requires an explicit isolated global root', () => {
  const root = project('harness-boundary-global-');
  const global = globalRoot();
  const candidate = writeJson(root, 'global-candidate', validMethod('global-boundary-explicit', 'global'));
  const projectMemory = path.join(root, 'Harness/memory/agent-lessons-patterns.md');
  const globalMemory = path.join(global, 'Harness/memory/agent-lessons-patterns.md');
  const apply = run(memoryContext, root, [
    'apply', '--project', root, '--global-root', global, '--input', candidate, '--apply', '--json',
  ]);
  assert.equal(apply.status, 0, apply.stdout);
  assert.doesNotMatch(fs.readFileSync(projectMemory, 'utf8'), /global-boundary-explicit rule/);
  assert.match(fs.readFileSync(globalMemory, 'utf8'), /global-boundary-explicit rule/);

  const globalQuery = run(memoryContext, root, [
    'query', '--project', root, '--global-root', global, '--scope', 'global', '--text', 'global-boundary-explicit', '--json',
  ]);
  assert.equal(globalQuery.status, 0, globalQuery.stdout);
  assert.ok(globalQuery.output.hits.some(hit => hit.id === 'global-boundary-explicit'));

  const missing = writeJson(root, 'global-candidate-missing', validMethod('global-boundary-missing', 'global'));
  const missingResult = run(memoryContext, root, [
    'apply', '--project', root, '--input', missing, '--apply', '--json',
  ]);
  assert.notEqual(missingResult.status, 0, missingResult.stdout);
  assert.doesNotMatch(fs.readFileSync(projectMemory, 'utf8'), /global-boundary-missing rule/);
});

test('AC-01/AC-04 research references retain supplied counterexample and recheck trigger', () => {
  const root = project('harness-boundary-research-');
  const referencesPath = path.join(root, 'Harness/tasks/boundary-task/REFERENCES.md');
  const reference = writeJson(root, 'research-reference', validReference({
    counterexample: 'If source terms change, stop using the adaptation',
    recheckTrigger: 'On public API or version change',
  }));
  const result = run(researchPolicy, root, [
    'record', '--project', root, '--task', 'boundary-task', '--input', reference, '--apply', '--json',
  ]);
  assert.equal(result.status, 0, result.stdout);
  const text = fs.readFileSync(referencesPath, 'utf8');
  assert.match(text, /If source terms change, stop using the adaptation/);
  assert.match(text, /On public API or version change/);
});

test('AC-04 query rejects negative byte budgets', () => {
  const root = project('harness-boundary-budget-');
  const result = run(memoryContext, root, [
    'query', '--project', root, '--scope', 'project', '--text', 'boundary', '--budget-bytes', '-1', '--json',
  ]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout, /budget|non-negative|invalid/i);
});

test('AC-04 query keeps skipped output bounded by the declared budget', () => {
  const root = project('harness-boundary-skipped-');
  const noisyDir = path.join(root, 'Harness/memory/noisy');
  fs.mkdirSync(noisyDir, { recursive: true });
  for (let index = 0; index < 20; index += 1) {
    fs.writeFileSync(path.join(noisyDir, `entry-${index}.md`), `- When context noise ${index}: ${'N'.repeat(300)}\n`, 'utf8');
  }
  const result = run(memoryContext, root, [
    'query', '--project', root, '--scope', 'project', '--text', 'context noise', '--top-k', '0', '--budget-bytes', '128', '--json',
  ]);
  assert.equal(result.status, 0, result.stdout);
  const skipped = result.output.skipped;
  assert.ok(skipped.length < 20 || skipped.some(item => item.truncated || item.count || item.summary), JSON.stringify(skipped));
  assert.ok(result.output.budget.usedBytes <= result.output.budget.limitBytes);
});
