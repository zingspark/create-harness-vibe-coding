// Independent release oracle regressions for B6 (AC-09).
// The scorer is the system under test; these fixtures only exercise the
// declared evidence contract and never create a benchmark result.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarnessTempRoot } from './support/temp-root.js';
import { scoreRun } from '../scripts/harness-intelligence-bench.mjs';

const REAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71]);

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function evidence(filePath, source) {
  return { path: filePath, sha256: sha256File(filePath), source };
}

function makeB6Run(screenshotName, screenshotBytes) {
  const root = makeHarnessTempRoot('verify-runtime-release-png-only-');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const statePath = path.join(projectRoot, 'canonical-state.json');
  const backendPath = path.join(root, 'backend.json');
  const uiPath = path.join(root, 'ui.json');
  const screenshotPath = path.join(root, screenshotName);
  fs.writeFileSync(statePath, '{"taskId":"task-png-only-092","status":"running"}\n');
  fs.writeFileSync(screenshotPath, screenshotBytes);
  const stateSha = sha256File(statePath);
  const backend = {
    projectRoot,
    taskId: 'task-png-only-092',
    url: 'http://127.0.0.1:3210',
    startedFromCli: true,
    openBrowser: false,
    lock: { mode: 'started', acquired: true },
    canonicalStatePath: statePath,
    canonicalStateSha256: stateSha,
  };
  const ui = {
    projectRoot,
    taskId: 'task-png-only-092',
    url: backend.url,
    observedAfterCli: true,
    canonicalStatePath: statePath,
    canonicalStateSha256: stateSha,
    api: { projectRoot, taskId: backend.taskId },
  };
  fs.writeFileSync(backendPath, `${JSON.stringify(backend)}\n`);
  fs.writeFileSync(uiPath, `${JSON.stringify(ui)}\n`);
  const report = scoreRun({
    isolatedRoot: root,
    evidenceRoot: root,
    categories: {
      B6: {
        backendEvidence: evidence(backendPath, 'independent-b6-backend'),
        uiEvidence: evidence(uiPath, 'independent-b6-ui'),
        canonicalStateEvidence: evidence(statePath, 'independent-b6-state'),
        screenshotEvidence: evidence(screenshotPath, 'independent-b6-screenshot'),
      },
    },
  });
  return { root, report };
}

test('AC-09 PNG-only oracle rejects pseudo JPEG and WebP as IMAGE_FORMAT_UNSUPPORTED', () => {
  for (const extension of ['jpg', 'jpeg', 'webp']) {
    const { root, report } = makeB6Run(`pseudo.${extension}`, Buffer.from(
      extension === 'webp' ? 'RIFF\x00\x00\x00\x00WEBPVP8 ' : '\xff\xd8\xff\xe0pseudo-image',
      'binary',
    ));
    try {
      assert.equal(report.categories.B6.status, 'fail', `${extension} must not pass B6`);
      assert.equal(report.categories.B6.code, 'IMAGE_FORMAT_UNSUPPORTED',
        `${extension} must be rejected by format policy: ${report.categories.B6.message}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
});

test('AC-09 PNG-only oracle preserves real PNG pass and malformed PNG rejection', () => {
  const valid = makeB6Run('real.png', REAL_PNG);
  try {
    assert.equal(valid.report.categories.B6.status, 'pass', valid.report.categories.B6.message);
    assert.equal(valid.report.categories.B6.evidence.image.format, 'png');
    assert.equal(valid.report.categories.B6.evidence.image.width, 1);
    assert.equal(valid.report.categories.B6.evidence.image.height, 1);
  } finally {
    fs.rmSync(valid.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }

  const malformed = makeB6Run('bad.png', PNG_SIGNATURE);
  try {
    assert.equal(malformed.report.categories.B6.status, 'fail', 'signature-only PNG must not pass B6');
    assert.equal(malformed.report.categories.B6.code, 'IMAGE_NOT_DECODABLE');
  } finally {
    fs.rmSync(malformed.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
