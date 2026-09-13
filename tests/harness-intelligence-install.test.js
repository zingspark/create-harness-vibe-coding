import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeHarnessTempRoot } from './support/temp-root.js';

const repoRoot = path.resolve('.');
const bin = path.resolve('bin/create-harness-vibe-coding.js');
const fixtureRoot = path.resolve('tests/fixtures/harness-intelligence-install/project');

function installProject(prefix = 'harness-intelligence-install-') {
  const parent = makeHarnessTempRoot(prefix);
  const target = path.join(parent, 'project');
  const result = spawnSync(process.execPath, [
    bin,
    'isolated-install',
    target,
    '-y',
    '--install-scope',
    'project',
    '--json',
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  fs.cpSync(path.join(fixtureRoot, 'Harness', 'tasks'), path.join(target, 'Harness', 'tasks'), { recursive: true });
  fs.cpSync(path.join(fixtureRoot, 'Harness', 'memory'), path.join(target, 'Harness', 'memory'), { recursive: true });
  return target;
}

function runInstalled(root, scriptName, args) {
  const script = path.join(root, 'Harness', 'scripts', scriptName);
  assert.ok(fs.existsSync(script), `missing installed script: ${scriptName}`);
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
}

function parseJson(result, label) {
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    assert.fail(`${label} did not return JSON: status=${result.status}; stdout=${result.stdout}; stderr=${result.stderr}`);
  }
}

test('AC-03/AC-09 project install ships executable local intelligence scripts and legacy reads', () => {
  const root = installProject();
  const scripts = [
    'task-context.mjs',
    'memory-context.mjs',
    'research-policy.mjs',
    'task-state.mjs',
    'lib/memory-context.mjs',
    'lib/research-policy.mjs',
  ];
  for (const relative of scripts) assert.ok(fs.existsSync(path.join(root, 'Harness', 'scripts', relative)), relative);

  for (const name of ['task-context.mjs', 'memory-context.mjs', 'research-policy.mjs']) {
    const script = path.join(root, 'Harness', 'scripts', name);
    const source = fs.readFileSync(script, 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      const dependency = path.resolve(path.dirname(script), match[1]);
      assert.ok(fs.existsSync(dependency), `${name} dependency is not installed: ${match[1]}`);
    }
    assert.doesNotMatch(source, /(?:^|[\\/])src[\\/]generator\.js|create-harness-vibe-coding[\\/]src[\\/]/i);
  }

  const show = runInstalled(root, 'task-context.mjs', [
    'show', 'install-fixture', '--project', root, '--json',
  ]);
  assert.equal(show.status, 0, show.stderr || show.stdout);
  assert.equal(parseJson(show, 'installed task-context show').taskId, 'install-fixture');

  const pack = runInstalled(root, 'task-context.mjs', [
    'pack', 'install-fixture', '--project', root, '--role', 'verifier', '--budget-bytes', '2048', '--json',
  ]);
  assert.equal(pack.status, 0, pack.stderr || pack.stdout);
  const packed = parseJson(pack, 'installed task-context pack');
  assert.match(packed.pack, /Execute the generated scripts/);
  assert.ok(packed.budget.usedBytes <= packed.budget.limitBytes);

  const query = runInstalled(root, 'memory-context.mjs', [
    'query', '--project', root, '--text', 'install relative', '--scope', 'project', '--json',
  ]);
  assert.equal(query.status, 0, query.stderr || query.stdout);
  assert.ok(parseJson(query, 'installed memory query').hits.some(hit => hit.id === 'install-memory'));

  const decide = runInstalled(root, 'research-policy.mjs', [
    'decide', '--trigger', 'capability-gap', '--task-type', 'chore', '--json',
  ]);
  assert.equal(decide.status, 0, decide.stderr || decide.stdout);
  const decision = parseJson(decide, 'installed research decision');
  assert.equal(decision.search, true);
  assert.equal(decision.addDependency, false);

  const legacy = runInstalled(root, 'task-context.mjs', [
    'show', 'legacy-fixture', '--project', root, '--json',
  ]);
  assert.equal(legacy.status, 0, legacy.stderr || legacy.stdout);
  const legacyOutput = parseJson(legacy, 'installed legacy show');
  assert.equal(legacyOutput.legacyContext, true);
  assert.match(JSON.stringify(legacyOutput), /Read an old task without a context object/);
});

test('AC-08 package includes intelligence templates and dependencies without leaking root task state', () => {
  const result = process.platform === 'win32'
    ? spawnSync('npm pack --dry-run --json', { cwd: repoRoot, encoding: 'utf8', shell: true })
    : spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim())[0];
  const files = report.files.map(file => file.path.replaceAll('\\', '/'));
  const expected = [
    'templates/common/Harness/scripts/task-context.mjs',
    'templates/common/Harness/scripts/memory-context.mjs',
    'templates/common/Harness/scripts/research-policy.mjs',
    'templates/common/Harness/scripts/task-state.mjs',
    'templates/common/Harness/scripts/lib/memory-context.mjs',
    'templates/common/Harness/scripts/lib/research-policy.mjs',
  ];
  for (const file of expected) assert.ok(files.includes(file), `npm pack omitted ${file}`);
  assert.equal(files.some(file => file.includes('Harness/tasks/task-upgrade-harness-092')), false);
  assert.equal(files.some(file => file.startsWith('tests/fixtures/')), false);
  const packageVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  assert.match(packageVersion, /^\d+\.\d+\.\d+$/, 'package version should remain valid semver');
});
