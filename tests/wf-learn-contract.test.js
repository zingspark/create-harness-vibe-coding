import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

test('AC-WFLEARN-001 wf-learn separates instance facts from reusable methods', () => {
  const skill = read('.claude/skills/wf-learn/SKILL.md');

  for (const marker of [
    'Generalization Gate',
    'instance facts',
    '<target-port>',
    'Probe',
    'Identify',
    'Act',
    'Verify',
    'counterexample',
  ]) {
    assert.match(skill, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), marker);
  }
  assert.match(skill, /must not be written to durable\s+memory/i);
  assert.doesNotMatch(skill, /COM5 is the rule/i);
});

test('AC-WFLEARN-002 wf-learn reports load proof and refuses unsupported guarantees', () => {
  const skill = read('.claude/skills/wf-learn/SKILL.md');

  assert.match(skill, /memory hints loaded:/i);
  assert.match(skill, /critical.*route|route.*critical/i);
  assert.match(skill, /cannot guarantee|not guaranteed|unsupported guarantee/i);
  assert.match(skill, /environment profile/i);
});

test('AC-WFLEARN-003 wf-learn mirrors stay byte-identical across runtimes and templates', () => {
  const skill = read('.claude/skills/wf-learn/SKILL.md');
  assert.equal(read('.agents/skills/wf-learn/SKILL.md'), skill);
  assert.equal(read('templates/common/.claude/skills/wf-learn/SKILL.md'), skill);

  const command = read('.claude/commands/wf-learn.md');
  assert.equal(read('.opencode/commands/wf-learn.md'), command);
  assert.equal(read('templates/common/.claude/commands/wf-learn.md'), command);
});
