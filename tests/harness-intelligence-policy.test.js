import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeHarnessTempRoot } from './support/temp-root.js';

const repoRoot = path.resolve('.');
const bin = path.resolve('bin/create-harness-vibe-coding.js');
const tempRoots = new Set();

function installProject(prefix = 'harness-intelligence-policy-') {
  const parent = makeHarnessTempRoot(prefix);
  tempRoots.add(parent);
  const target = path.join(parent, 'project');
  const result = spawnSync(process.execPath, [bin, 'policy-install', target, '-y', '--install-scope', 'project', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return target;
}

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function read(root, relative) {
  const file = path.join(root, relative);
  assert.ok(fs.existsSync(file), `missing generated policy surface: ${relative}`);
  return fs.readFileSync(file, 'utf8');
}

test('AC-01 direct help/list surfaces do not enter WF or force research', () => {
  const root = installProject();
  const surface = JSON.parse(read(root, 'Harness/specs/runtime/command-surface.json'));
  const direct = surface.commands.filter(command => command.classification === 'direct');
  assert.ok(direct.some(command => command.id === 'wf-help' && command.entersWf === false));
  assert.ok(direct.some(command => command.id === 'wf-task-list' && command.entersWf === false));

  const help = read(root, '.claude/commands/wf-help.md');
  assert.match(help, /Do not invoke a skill/i);
  assert.match(help, /do not start WF mode/i);
  assert.doesNotMatch(help, /research-policy\.mjs|web research|external research/i);

  const taskList = read(root, '.claude/commands/wf-task-list.md');
  assert.doesNotMatch(taskList, /research-policy\.mjs|web research|enter WF mode/i);
});

test('AC-03/AC-01 wf and wf-max explicitly consume bounded context packs and research decisions', () => {
  const root = installProject();
  for (const command of ['wf', 'wf-max']) {
    const commandText = read(root, `.claude/commands/${command}.md`);
    const skillText = read(root, `.claude/skills/${command}/SKILL.md`);
    const workflowText = read(root, `Harness/specs/workflows/${command === 'wf' ? 'WF' : 'WF-MAX'}.md`);
    const text = `${commandText}\n${skillText}\n${workflowText}`;
    assert.match(text, /task-context\.mjs/ , `${command} must name task-context CLI`);
    assert.match(text, /\bpack\b/, `${command} must consume a context pack`);
    assert.match(text, /research-policy\.mjs/, `${command} must name research-policy CLI`);
    assert.match(text, /\bdecide\b/, `${command} must consume research decisions`);
  }
});

test('AC-04 wf-learn exposes executable memory query/validate/apply/feedback flow', () => {
  const root = installProject();
  const commandText = read(root, '.claude/commands/wf-learn.md');
  const skillText = read(root, '.claude/skills/wf-learn/SKILL.md');
  const text = `${commandText}\n${skillText}`;
  assert.match(text, /memory-context\.mjs/, 'wf-learn must name executable memory CLI');
  for (const operation of ['query', 'validate', 'apply', 'feedback']) {
    assert.match(text, new RegExp(`\\b${operation}\\b`), `wf-learn must route ${operation}`);
  }
});

test('AC-03 wf-max useful may record a no-spawn dependency-chain decision while strict remains explicit fan-out', () => {
  const root = installProject();
  const text = [
    read(root, '.claude/commands/wf-max.md'),
    read(root, '.claude/skills/wf-max/SKILL.md'),
    read(root, 'Harness/specs/workflows/WF-MAX.md'),
  ].join('\n');
  assert.match(text, /WF-Max-Useful[\s\S]{0,1800}(?:no[- ]spawn|without (?:a )?spawn|skip(?:ping)? (?:the )?fan[- ]out|fan[- ]out (?:is )?not needed|dependency chain)/i);
  assert.match(text, /(?:record|persist|log)[\s\S]{0,400}(?:reason|rationale)[\s\S]{0,400}(?:no[- ]spawn|fan[- ]out)/i);
  assert.match(text, /WF-Max-Strict[\s\S]{0,1000}(?:explicit|unconditional)[\s\S]{0,300}(?:fan[- ]out|spawn)/i);
});
