import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeHarnessTempRoot } from './support/temp-root.js';

const SCRIPT = path.resolve('Harness', 'scripts', 'wf-auto-update-prompt.mjs');

function writeFixture(root, { from, to }) {
  fs.mkdirSync(path.join(root, 'Harness', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Harness', '.harness-version'), JSON.stringify({ generator: from }), 'utf8');
  fs.writeFileSync(
    path.join(root, 'Harness', 'scripts', 'wf-update-check.mjs'),
    `console.log(JSON.stringify({ status: 'update-available', from: ${JSON.stringify(from)}, to: ${JSON.stringify(to)} }));\n`,
    'utf8',
  );
}

function runPrompt(root) {
  const result = spawnSync(process.execPath, [SCRIPT, '--force', '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, WF_ROOT: root },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

function withFixture({ from, to }, run) {
  const root = makeHarnessTempRoot('update-prompt-');
  try {
    writeFixture(root, { from, to });
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('patch-only updates stay silent in the startup hook', () => {
  withFixture({ from: '0.8.20', to: '0.8.21' }, (root) => {
    const output = runPrompt(root).trim();
    assert.equal(output, '', 'patch-only updates must produce no hook output');
    assert.doesNotMatch(output, /Harness update available/);
  });
});

test('minor and major updates still notify through the startup hook', () => {
  for (const to of ['0.9.0', '1.0.0']) {
    withFixture({ from: '0.8.20', to }, (root) => {
      const output = runPrompt(root);
      assert.match(output, /Harness update available/);
      assert.match(output, new RegExp(`${to.replace(/\./g, '\\.')}`));
    });
  }
});

test('unparseable remote versions fail open and notify', () => {
  withFixture({ from: '0.8.20', to: 'next' }, (root) => {
    const output = runPrompt(root);
    assert.match(output, /Harness update available/);
  });
});
