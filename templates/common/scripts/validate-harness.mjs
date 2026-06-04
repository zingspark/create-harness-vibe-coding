#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const strict = args.has('--strict') || args.has('--post-bootstrap');

if (args.has('--help') || args.has('-h')) {
  console.log(`Usage: node scripts/validate-harness.mjs [--strict]

Default mode checks scaffold structure, links, agents, and skills.
--strict also fails when project fact docs still contain {{...}} placeholders.`);
  process.exit(0);
}

const commonAgents = [
  'researcher',
  'docs-researcher',
  'planner',
  'architect',
  'test-writer',
  'implementer',
  'debugger',
  'reviewer',
  'verifier',
];

const commonSkills = [
  'harness-router',
  'harness-lifecycle',
  'harness-research',
  'harness-context',
  'harness-build-loop',
];

const required = [
  'AGENTS.md',
  'CLAUDE.md',
  'MEMORY.md',
  '.claude/settings.json',
  '.claude/rules/ecc/common.md',
  ...commonAgents.map(agent => `.claude/agents/${agent}.md`),
  ...commonSkills.map(skill => `.claude/skills/${skill}/SKILL.md`),
  'docs/README.md',
  'docs/harness/PLAN.md',
  'docs/harness/lifecycle.md',
  'docs/harness/dispatch.md',
  'docs/harness/extension.md',
  'docs/harness/context-loading.md',
  'docs/harness/agent-workflow.md',
  'docs/harness/architecture.md',
  'docs/harness/data-flow.md',
  'docs/harness/state-machines.md',
  'docs/features/_template.md',
  'docs/research/README.md',
  'docs/research/research-results.md',
  'docs/research/PRD.md',
  'docs/domain/ports.md',
];

const projectFacts = [
  'docs/harness/PLAN.md',
  'docs/research/PRD.md',
  'docs/research/research-results.md',
  'docs/harness/architecture.md',
  'docs/domain/ports.md',
];

const contextPacks = [
  'Explorer Pass:',
  'Planner:',
  'Researcher:',
  'Docs Researcher:',
  'Architect:',
  'Test Writer:',
  'Implementer:',
  'Reviewer:',
  'Debugger:',
  'Verifier:',
];

const errors = [];

function read(rel) {
  const file = path.join(root, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function requireText(rel, text, label = text) {
  const body = read(rel);
  if (body && !body.includes(text)) errors.push(`${rel} missing ${label}`);
}

function frontmatterField(text, field) {
  const match = text.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : '';
}

for (const rel of required) {
  if (!fs.existsSync(path.join(root, rel))) {
    errors.push(`missing required file: ${rel}`);
  }
}

if (fs.existsSync(path.join(root, 'docs/research/scaffolds.md'))) {
  errors.push('legacy research file should be renamed: docs/research/scaffolds.md -> docs/research/research-results.md');
}

if (strict) {
  for (const rel of projectFacts) {
    const text = read(rel);
    if (text.includes('{{')) {
      errors.push(`template placeholders remain in project fact file: ${rel}`);
    }
  }
}

const docsReadme = read('docs/README.md');
if (docsReadme) {
  for (const marker of ['## Keyword Routing', '## Load By Task', 'When to Read', 'Keywords']) {
    if (!docsReadme.includes(marker)) errors.push(`docs/README.md missing router marker: ${marker}`);
  }
}

const plan = read('docs/harness/PLAN.md');
if (plan) {
  for (const heading of ['## Current Goal', '## Phase', '## Success Criteria', '## Loaded Context', '## Tasks', '## Parallel Dispatch', '## Verification']) {
    if (!plan.includes(heading)) errors.push(`docs/harness/PLAN.md missing heading: ${heading}`);
  }
}

const dispatch = read('docs/harness/dispatch.md');
if (dispatch) {
  for (const agent of commonAgents) {
    if (!dispatch.includes(`\`${agent}\``)) errors.push(`docs/harness/dispatch.md missing common agent: ${agent}`);
  }
  if (!dispatch.includes('## Handoff Format')) errors.push('docs/harness/dispatch.md missing heading: ## Handoff Format');
}

const contextLoading = read('docs/harness/context-loading.md');
if (contextLoading) {
  if (!contextLoading.includes('docs/README.md` is the primary router')) {
    errors.push('docs/harness/context-loading.md must declare docs/README.md as the primary router');
  }
  for (const pack of contextPacks) {
    if (!contextLoading.includes(pack)) errors.push(`docs/harness/context-loading.md missing subagent pack: ${pack}`);
  }
}

const memory = read('MEMORY.md');
if (memory) {
  for (const agent of commonAgents) {
    const rel = `.claude/agents/${agent}.md`;
    if (!memory.includes(rel)) errors.push(`MEMORY.md missing agent registration: ${rel}`);
  }
  for (const skill of commonSkills) {
    const rel = `.claude/skills/${skill}/SKILL.md`;
    if (!memory.includes(rel)) errors.push(`MEMORY.md missing skill registration: ${rel}`);
  }
}

for (const skill of commonSkills) {
  const rel = `.claude/skills/${skill}/SKILL.md`;
  const text = read(rel);
  if (!text) continue;
  if (frontmatterField(text, 'name') !== skill) errors.push(`${rel} frontmatter name does not match directory`);
  if (!frontmatterField(text, 'description')) errors.push(`${rel} missing frontmatter field: description`);
}

for (const agent of commonAgents) {
  const rel = `.claude/agents/${agent}.md`;
  const text = read(rel);
  if (!text) continue;

  for (const field of ['name', 'description', 'tools', 'model', 'skills']) {
    if (!frontmatterField(text, field)) errors.push(`${rel} missing frontmatter field: ${field}:`);
  }

  if (frontmatterField(text, 'name') !== agent) {
    errors.push(`${rel} frontmatter name does not match filename`);
  }

  const skill = frontmatterField(text, 'skills');
  if (skill && !commonSkills.includes(skill)) {
    errors.push(`${rel} references unknown skill: ${skill}`);
  }

  if (skill && !fs.existsSync(path.join(root, `.claude/skills/${skill}/SKILL.md`))) {
    errors.push(`${rel} references missing skill file: .claude/skills/${skill}/SKILL.md`);
  }
}

requireText('docs/harness/extension.md', 'Skills should extend the harness');
requireText('docs/harness/agent-workflow.md', 'docs/harness/PLAN.md');
requireText('docs/research/README.md', 'research-results.md');

if (errors.length) {
  console.error(`Harness validation failed${strict ? ' (strict)' : ''}:`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Harness validation passed${strict ? ' (strict)' : ''}.`);
if (!strict) {
  console.log('Tip: run `node scripts/validate-harness.mjs --strict` after bootstrap to check unresolved project placeholders.');
}
