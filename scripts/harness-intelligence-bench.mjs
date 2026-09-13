#!/usr/bin/env node

/*
 * Harness 0.9.2 benchmark fixture oracle.
 *
 * This file is intentionally a repository-only evaluator. It never creates a
 * candidate result, transcript, task state, or agent trace. A missing or
 * unverifiable artifact is reported as NOT_RUN/fail.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FIXTURE_ROOT = path.join(SCRIPT_ROOT, 'benchmarks', 'harness-intelligence-092');
const BENCHMARK_ID = 'harness-intelligence-092';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const EXPECTED_B2 = { noFlag: 1350, excludeRefunds: 1800 };
const REVIEW_STATUSES = new Set(['pass', 'pending', 'fail']);
const RESULT_STATUSES = new Set(['pass', 'fail', 'not_run', 'pending', 'skip', 'succeeded', 'failed', 'cancelled']);
const EXPECTED_RECORDS = [
  { id: 'a', amountMinor: 1200, currency: 'CNY' },
  { id: 'b', amountMinor: 600, currency: 'CNY' },
  { id: 'r', amountMinor: -450, currency: 'CNY' },
];

function fail(message, code = 'INVALID_EVIDENCE') {
  return { ok: false, status: 'fail', code, message };
}

function notRun(message, code = 'NOT_RUN') {
  return { ok: false, status: 'not_run', code, message };
}

function pending(message, code = 'PENDING_REVIEW') {
  return { ok: false, status: 'pending', code, message };
}

function pass(message, evidence = {}) {
  return { ok: true, status: 'pass', message, evidence };
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`unable to read ${file}: ${error.message}`);
  }
}

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch (error) {
    throw new Error(`unable to read JSON ${file}: ${error.message}`);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function isDirectory(directory) {
  try { return fs.statSync(directory).isDirectory(); } catch { return false; }
}

function pathInside(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

function absolutePath(value) {
  return typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value) : null;
}

function pathWithinAny(candidate, roots) {
  return roots.some(root => typeof root === 'string' && pathInside(root, candidate));
}

function requireFile(value, label, roots = []) {
  const resolved = absolutePath(value);
  if (!resolved) return notRun(`${label} must be an absolute path (NOT_RUN)`, 'NOT_RUN');
  if (roots.length && !pathWithinAny(resolved, roots)) return fail(`${label} is outside the declared evidence roots`, 'BOUNDARY');
  if (!isFile(resolved)) return notRun(`${label} is missing: ${resolved} (NOT_RUN)`, 'NOT_RUN');
  if (roots.length) {
    let realCandidate;
    try { realCandidate = fs.realpathSync(resolved); } catch { return notRun(`${label} cannot be resolved on disk (NOT_RUN)`, 'NOT_RUN'); }
    const realRoots = roots.map(root => {
      try { return fs.realpathSync(root); } catch { return null; }
    }).filter(Boolean);
    if (!pathWithinAny(realCandidate, realRoots)) return fail(`${label} resolves outside the declared evidence roots`, 'BOUNDARY');
  }
  return { ok: true, path: resolved };
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) return fail(`${label} must be a SHA-256 hex digest`, 'BAD_HASH');
  return pass(`${label} is a SHA-256 digest`);
}

function verifyFileRef(ref, label, roots = [], options = {}) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return notRun(`${label} evidence reference is missing (NOT_RUN)`, 'NOT_RUN');
  if (typeof ref.source !== 'string' || !ref.source.trim()) return fail(`${label} evidence source is missing`, 'BAD_EVIDENCE_SOURCE');
  const file = requireFile(ref.path, `${label} evidence path`, roots);
  if (!file.ok) return file;
  const hash = requireHash(ref.sha256, `${label} evidence sha256`);
  if (!hash.ok) return hash;
  if (fileSha256(file.path).toLowerCase() !== ref.sha256.toLowerCase()) return fail(`${label} evidence hash does not match the file on disk`, 'HASH_MISMATCH');
  if (options.nonEmpty && fs.statSync(file.path).size === 0) return fail(`${label} evidence file is empty`, 'EMPTY_EVIDENCE');
  return { ok: true, path: file.path, sha256: ref.sha256.toLowerCase(), source: ref.source };
}

function readJsonLines(file, label) {
  const text = readText(file);
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error(`${label} must contain non-empty JSONL`);
  return lines.map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`${label} line ${index + 1} is not JSON: ${error.message}`); }
  });
}

function readJsonFile(file, label) {
  let value;
  try { value = readJson(file); } catch (error) { return fail(`${label}: ${error.message}`, 'NOT_RUN'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${label} must be a JSON object`, 'BAD_EVIDENCE');
  return { ok: true, value };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
  }
  return value;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validImageBytes(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (error) { return { ok: false, message: error.message }; }
  const extension = path.extname(file).toLowerCase();
  if (extension === '.png') return decodePng(bytes);
  return { ok: false, code: 'IMAGE_FORMAT_UNSUPPORTED', message: 'only PNG screenshots are mechanically supported; JPEG/WebP require a real decoder and remain pending/manual-review evidence' };
}

// Keep this dependency-free: the benchmark package does not ship a mature
// image decoder. This minimal PNG path parses and decompresses the image
// payload rather than trusting a filename or a four-byte signature. It
// establishes PNG byte decodability, not that pixels came from the claimed
// browser session; independent browser trace/manual review remains required.
function decodePng(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < signature.length || !bytes.subarray(0, 8).equals(signature)) return { ok: false, message: 'invalid PNG signature' };
  let offset = 8;
  let header;
  let ended = false;
  let palette;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return { ok: false, message: 'truncated PNG chunk' };
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([bytes.subarray(offset + 4, offset + 8), data]));
    if (expectedCrc !== actualCrc) return { ok: false, message: `PNG ${type} chunk has an invalid CRC` };
    if (type === 'IHDR') {
      if (header || length !== 13) return { ok: false, message: 'invalid PNG IHDR' };
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      if (!width || !height || width > 100_000 || height > 100_000 || width * height > 100_000_000 || data[10] !== 0 || data[11] !== 0 || ![0, 2, 3, 4, 6].includes(colorType)) return { ok: false, message: 'invalid PNG dimensions/header' };
      const allowedDepths = colorType === 2 ? [8, 16] : colorType === 3 ? [1, 2, 4, 8] : colorType === 0 ? [1, 2, 4, 8, 16] : [8, 16];
      if (!allowedDepths.includes(bitDepth) || ![0, 1].includes(data[12])) return { ok: false, message: 'invalid PNG bit depth/interlace' };
      header = { width, height, bitDepth, colorType, interlace: data[12] };
    } else if (type === 'IDAT') {
      if (!header) return { ok: false, message: 'PNG IDAT precedes IHDR' };
      idat.push(data);
    } else if (type === 'PLTE') {
      if (!data.length || data.length % 3 !== 0) return { ok: false, message: 'invalid PNG palette' };
      palette = data.length / 3;
    } else if (type === 'IEND') {
      if (length !== 0 || ended) return { ok: false, message: 'invalid PNG IEND' };
      ended = true;
      if (end !== bytes.length) return { ok: false, message: 'PNG has trailing bytes' };
    }
    offset = end;
    if (ended) break;
  }
  if (!header || !idat.length || !ended || offset !== bytes.length || (header.colorType === 3 && (!palette || palette > (2 ** header.bitDepth)))) return { ok: false, message: 'PNG is missing IHDR, IDAT, IEND, or palette' };
  let decoded;
  try { decoded = inflateSync(Buffer.concat(idat)); } catch (error) { return { ok: false, message: `PNG payload is not decodable: ${error.message}` }; }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  const passSize = (width, height) => height ? (Math.ceil(width * channels * header.bitDepth / 8) + 1) * height : 0;
  const adam7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const expected = header.interlace === 0
    ? passSize(header.width, header.height)
    : adam7.reduce((sum, [x0, y0, dx, dy]) => sum + passSize(Math.max(0, Math.floor((header.width - x0 + dx - 1) / dx)), Math.max(0, Math.floor((header.height - y0 + dy - 1) / dy))), 0);
  if (decoded.length !== expected) return { ok: false, message: 'PNG scanline payload has an invalid decoded length' };
  for (let index = 0; index < decoded.length;) {
    const rowWidth = header.interlace === 0 ? header.width : null;
    // For Adam7, each pass is validated below; for non-interlaced images each
    // scanline starts with a filter byte in the range defined by PNG.
    if (rowWidth !== null) {
      const rowBytes = Math.ceil(rowWidth * channels * header.bitDepth / 8) + 1;
      for (let row = 0; row < header.height; row += 1) if (![0, 1, 2, 3, 4].includes(decoded[index + row * rowBytes])) return { ok: false, message: 'PNG scanline uses an invalid filter' };
      break;
    }
    for (const [x0, y0, dx, dy] of adam7) {
      const width = Math.max(0, Math.floor((header.width - x0 + dx - 1) / dx));
      const height = Math.max(0, Math.floor((header.height - y0 + dy - 1) / dy));
      const rowBytes = Math.ceil(width * channels * header.bitDepth / 8) + 1;
      for (let row = 0; row < height; row += 1) {
        if (![0, 1, 2, 3, 4].includes(decoded[index])) return { ok: false, message: 'PNG scanline uses an invalid filter' };
        index += rowBytes;
      }
    }
  }
  return { ok: true, format: 'png', width: header.width, height: header.height };
}

function ownKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
}

function validateData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('data.json must be an object', 'BAD_FIXTURE');
  if (!sameJson(ownKeys(data), ['records'])) return fail('data.json must contain only records', 'ANSWER_LEAK');
  if (!Array.isArray(data.records) || !sameJson(data.records, EXPECTED_RECORDS)) return fail('data.json records differ from the frozen fixture', 'BAD_FIXTURE');
  if (data.records.some(record => !sameJson(ownKeys(record), ['amountMinor', 'currency', 'id']))) return fail('records contain unexpected answer fields', 'ANSWER_LEAK');
  return pass('billing fixture contains records only');
}

export function validateFixture(fixtureRoot = DEFAULT_FIXTURE_ROOT) {
  const root = path.resolve(fixtureRoot);
  const required = [
    'manifest.json',
    'b1/sentinel.txt',
    'b2/data.json',
    'b2/stage1-user-prompt.md',
    'b2/stage2-user-prompt.md',
    'b2/baseline-handoff.md',
    'b2/handoff.md',
    'b3/user-prompt.md',
    'b4/user-prompt.md',
    'b5/user-prompt.md',
    'b6/user-prompt.md',
    'evidence-template.md',
    'report.schema.json',
  ];
  const missing = required.filter(rel => !isFile(path.join(root, ...rel.split('/'))));
  if (missing.length) return fail(`fixture files missing: ${missing.join(', ')}`, 'MISSING_FIXTURE');
  const manifest = readJson(path.join(root, 'manifest.json'));
  if (manifest.schemaVersion !== 1 || manifest.benchmarkId !== BENCHMARK_ID || manifest.packageExcluded !== true || manifest.sealedHoldoutExcluded !== true) {
    return fail('manifest does not declare the benchmark/package boundary', 'BAD_MANIFEST');
  }
  if (!manifest.scenarios?.B4 || manifest.scenarios.B4.status === 'skip' || manifest.scenarios.B4.notApplicable === true) {
    return fail('manifest must keep B4 as a required scored scenario', 'B4_REQUIRED');
  }
  const dataCheck = validateData(readJson(path.join(root, 'b2', 'data.json')));
  if (!dataCheck.ok) return dataCheck;
  const holdoutNames = new Set(['BENCHMARK-HOLDOUT.json', 'holdout.json', 'answers.json']);
  const leaked = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (holdoutNames.has(entry.name)) leaked.push(path.relative(root, full));
    }
  };
  walk(root);
  if (leaked.length) return fail(`sealed/answer files are present: ${leaked.join(', ')}`, 'ANSWER_LEAK');
  return pass('fixture is complete and contains no holdout or B2 answer in data.json', {
    fixtureRoot: root,
    sentinelSha256: sha256(readText(path.join(root, 'b1', 'sentinel.txt'))),
    files: required,
  });
}

export function evaluateB2Output(value, expectedTotal) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('CLI stdout was not a JSON object', 'BAD_OUTPUT');
  if (!sameJson(ownKeys(value), ['currency', 'totalMinor'])) return fail('CLI stdout must contain exactly currency and totalMinor', 'BAD_OUTPUT');
  if (value.currency !== 'CNY') return fail('CLI currency must be CNY', 'BAD_OUTPUT');
  if (!Number.isSafeInteger(value.totalMinor) || value.totalMinor !== expectedTotal) return fail(`CLI totalMinor must be ${expectedTotal}`, 'WRONG_OUTPUT');
  return pass('CLI output matches the public billing oracle', { value });
}

function invokeBilling(cliPath, dataPath, excludeRefunds) {
  if (!isFile(cliPath)) return notRun(`candidate CLI is missing: ${cliPath}`, 'NOT_RUN');
  if (!isFile(dataPath)) return notRun(`candidate data file is missing: ${dataPath}`, 'NOT_RUN');
  const args = [cliPath, dataPath];
  if (excludeRefunds) args.push('--exclude-refunds');
  const result = spawnSync(process.execPath, args, {
    cwd: path.dirname(cliPath),
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) return notRun(`candidate CLI could not run: ${result.error.message}`, 'NOT_RUN');
  if (result.status !== 0) return fail(`candidate CLI exited ${result.status}: ${(result.stderr || '').trim()}`, 'CLI_FAILED');
  let value;
  try { value = JSON.parse((result.stdout || '').trim()); } catch (error) {
    return fail(`candidate stdout is not exactly JSON: ${error.message}`, 'BAD_OUTPUT');
  }
  return { ...evaluateB2Output(value, excludeRefunds ? EXPECTED_B2.excludeRefunds : EXPECTED_B2.noFlag), stdout: result.stdout };
}

export function checkB2(run, fixtureRoot = DEFAULT_FIXTURE_ROOT) {
  const spec = run?.categories?.B2 || run?.B2;
  if (!spec || typeof spec !== 'object' || !absolutePath(run?.isolatedRoot)) return notRun('B2 evidence is missing (NOT_RUN)', 'NOT_RUN');
  const roots = [run.isolatedRoot];
  const cliFile = requireFile(spec.cliPath, 'B2 cliPath', roots);
  const dataFile = requireFile(spec.dataPath, 'B2 dataPath', roots);
  if (!cliFile.ok) return cliFile;
  if (!dataFile.ok) return dataFile;
  const cliPath = cliFile.path;
  const dataPath = dataFile.path;
  let data;
  try { data = readJson(dataPath); } catch (error) { return notRun(`${error.message} (NOT_RUN)`, 'NOT_RUN'); }
  const dataCheck = validateData(data);
  if (!dataCheck.ok) return dataCheck;
  const noFlag = invokeBilling(cliPath, dataPath, false);
  const excludeRefunds = invokeBilling(cliPath, dataPath, true);
  if (!noFlag.ok || !excludeRefunds.ok) {
    if (noFlag.status === 'not_run' || excludeRefunds.status === 'not_run') return notRun(`B2 oracle could not run: ${noFlag.message}; ${excludeRefunds.message}`, 'NOT_RUN');
    return fail(`B2 oracle failed: ${noFlag.message}; ${excludeRefunds.message}`, 'B2_FAILED');
  }
  return pass('both public B2 CLI forms passed', {
    dataPath,
    cliPath,
    noFlag: noFlag.evidence.value,
    excludeRefunds: excludeRefunds.evidence.value,
  });
}

function checkB1(run, fixtureRoot) {
  const spec = run?.categories?.B1;
  const isolatedRoot = absolutePath(run?.isolatedRoot);
  if (!spec || typeof spec !== 'object' || !isolatedRoot) return notRun('B1 evidence is missing (NOT_RUN)', 'NOT_RUN');
  const roots = [isolatedRoot, absolutePath(run?.evidenceRoot)].filter(Boolean);
  const installedRoot = absolutePath(spec.installedRoot);
  if (!installedRoot || !isDirectory(installedRoot) || !pathInside(isolatedRoot, installedRoot)) return fail('B1 installedRoot must be an existing absolute directory inside isolatedRoot', 'BOUNDARY');
  try {
    if (!pathInside(fs.realpathSync(isolatedRoot), fs.realpathSync(installedRoot))) return fail('B1 installedRoot resolves outside isolatedRoot', 'BOUNDARY');
  } catch { return notRun('B1 installedRoot cannot be resolved on disk (NOT_RUN)', 'NOT_RUN'); }
  const sentinelFile = requireFile(spec.sentinelPath, 'B1 sentinelPath', [installedRoot]);
  const artifactFile = requireFile(spec.installedArtifactPath, 'B1 installedArtifactPath', [installedRoot]);
  const packageArchive = verifyFileRef(spec.packageArchiveEvidence, 'B1 package archive', roots, { nonEmpty: true });
  const receiptFile = verifyFileRef(spec.installReceipt, 'B1 installReceipt', roots, { nonEmpty: true });
  const logFile = verifyFileRef(spec.installLog, 'B1 installLog', roots, { nonEmpty: true });
  if (!sentinelFile.ok) return sentinelFile;
  if (!artifactFile.ok) return artifactFile;
  if (!packageArchive.ok) return packageArchive;
  if (!receiptFile.ok) return receiptFile;
  if (!logFile.ok) return logFile;
  const expected = path.join(fixtureRoot, 'b1', 'sentinel.txt');
  if (!isFile(expected)) return notRun('B1 frozen sentinel fixture is missing (NOT_RUN)', 'NOT_RUN');
  if (readText(sentinelFile.path) !== readText(expected)) return fail('B1 sentinel changed during install', 'SENTINEL_CHANGED');
  const artifactSha = fileSha256(artifactFile.path);
  const packageSha = fileSha256(packageArchive.path);
  const sentinelSha = fileSha256(sentinelFile.path);
  if (spec.installedArtifactSha256 !== artifactSha) return fail('B1 installed artifact hash does not match disk', 'HASH_MISMATCH');
  if (spec.sentinelSha256 !== sentinelSha) return fail('B1 sentinel hash does not match disk', 'HASH_MISMATCH');
  if (run.packageHash.toLowerCase() !== packageSha.toLowerCase()) return fail('B1 packageHash does not match the preserved package archive bytes', 'PACKAGE_HASH_MISMATCH');
  const receipt = readJsonFile(receiptFile.path, 'B1 install receipt');
  if (!receipt.ok) return receipt;
  const r = receipt.value;
  if (r.sourceSha !== run.sourceSha || r.packageHash !== run.packageHash || path.resolve(r.packageArchivePath || '') !== packageArchive.path || r.packageArchiveSha256 !== packageSha || path.resolve(r.installedRoot || '') !== installedRoot || path.resolve(r.sentinelPath || '') !== sentinelFile.path || path.resolve(r.installedArtifactPath || '') !== artifactFile.path || r.artifactSha256 !== artifactSha || r.sentinelSha256 !== sentinelSha || !Array.isArray(r.files) || r.files.length === 0) {
    return fail('B1 install receipt does not agree with source, package, paths, and disk hashes', 'RECEIPT_MISMATCH');
  }
  const installLog = readText(logFile.path);
  if (!installLog.includes(run.sourceSha) || !installLog.includes(run.packageHash) || !/install|extract|pack/i.test(installLog)) return fail('B1 raw install log does not contain the recorded source/package and install action', 'BAD_RAW_LOG');
  return pass('B1 disk, sentinel, receipt, and raw install log agree (manual provenance review still required)', {
    mechanical: 'pass', reviewRequired: true, sentinelSha256: sentinelSha, packageHash: packageSha,
    installedArtifactSha256: artifactSha, installedArtifactPath: artifactFile.path, packageArchive: packageArchive.path,
    installReceipt: receiptFile.path, installLog: logFile.path,
  });
}

function eventKind(event) {
  return String(event?.kind || event?.type || event?.event || '').toLowerCase();
}

function checkB3(run) {
  const spec = run?.categories?.B3;
  const isolatedRoot = absolutePath(run?.isolatedRoot);
  if (!spec || typeof spec !== 'object' || !isolatedRoot) return notRun('B3 evidence is missing (NOT_RUN)', 'NOT_RUN');
  const roots = [isolatedRoot, absolutePath(run?.evidenceRoot)].filter(Boolean);
  const eventsRef = verifyFileRef(spec.eventsEvidence, 'B3 raw events', roots, { nonEmpty: true });
  const effectsRef = verifyFileRef(spec.sideEffectsEvidence, 'B3 raw side-effects log', roots, { nonEmpty: true });
  const executionRef = verifyFileRef(spec.executionEvidence, 'B3 raw execution log', roots, { nonEmpty: true });
  if (!eventsRef.ok) return eventsRef;
  if (!effectsRef.ok) return effectsRef;
  if (!executionRef.ok) return executionRef;
  let events;
  let effects;
  try { events = readJsonLines(eventsRef.path, 'B3 raw events'); effects = readJsonLines(effectsRef.path, 'B3 raw side-effects log'); }
  catch (error) { return fail(error.message, 'BAD_RAW_LOG'); }
  if (events.length < 6) return fail('B3 raw events must contain cancellation, failed attempt, retry, ACK, and RESULT evidence', 'BAD_EVENTS');
  const seqs = events.map(event => Number(event?.seq));
  if (seqs.some(seq => !Number.isSafeInteger(seq) || seq < 1) || seqs.some((seq, index) => index > 0 && seq <= seqs[index - 1])) return fail('B3 event sequence is not strictly monotonic', 'BAD_SEQUENCE');
  const hasRequest = events.some(event => eventKind(event).includes('request'));
  const hasAck = events.some(event => eventKind(event).includes('ack') || eventKind(event).includes('running'));
  const hasResult = events.some(event => eventKind(event).includes('result'));
  const hasCancelled = events.some(event => String(event?.status || '').toLowerCase() === 'cancelled');
  const hasFailed = events.some(event => String(event?.status || '').toLowerCase() === 'failed');
  if (!spec.retry || spec.retry.explicit !== true || !Number.isSafeInteger(spec.retry.attempt) || spec.retry.attempt < 2) return fail('B3 explicit failure/retry evidence is missing', 'RETRY_NOT_PROVEN');
  const currentAttempt = spec.retry.attempt;
  const actionEvents = events.filter(event => {
    const kind = eventKind(event);
    return kind.includes('request') || kind.includes('ack') || kind.includes('running') || kind.includes('result') || kind.includes('cancel') || kind.includes('fail') || TERMINAL.has(String(event?.status || '').toLowerCase());
  });
  const dispatchesById = new Map();
  const requestToDispatch = new Map();
  const requestIds = new Set();
  const sessionIds = new Set();
  const taskIds = new Set();
  const taskIdEvents = actionEvents.filter(event => event?.taskId !== undefined).length;
  for (const event of actionEvents) {
    const dispatchId = String(event?.dispatchId || '');
    const sessionId = String(event?.sessionId || '');
    const requestId = String(event?.requestId || '');
    const attempt = event?.attempt;
    if (!dispatchId || !sessionId || !requestId || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > currentAttempt) return fail('B3 ACK/failure/cancellation/RESULT is missing the joined dispatchId/sessionId/requestId/attempt identity', 'IDENTITY_JOIN_FAILED');
    if (event?.replyTo !== undefined && String(event.replyTo) !== requestId) return fail('B3 terminal or ACK event points at a stale requestId', 'STALE_ATTEMPT');
    const taskId = event?.taskId === undefined ? '' : String(event.taskId);
    if (taskId) taskIds.add(taskId);
    requestIds.add(requestId);
    sessionIds.add(sessionId);
    const priorDispatch = requestToDispatch.get(requestId);
    if (priorDispatch !== undefined && priorDispatch !== dispatchId) return fail('B3 one requestId is joined to multiple dispatchIds', 'IDENTITY_JOIN_FAILED');
    requestToDispatch.set(requestId, dispatchId);
    let dispatch = dispatchesById.get(dispatchId);
    if (!dispatch) {
      dispatch = { dispatchId, attempts: new Map(), taskIds: new Set() };
      dispatchesById.set(dispatchId, dispatch);
    }
    if (taskId) dispatch.taskIds.add(taskId);
    let attemptGroup = dispatch.attempts.get(attempt);
    if (!attemptGroup) {
      attemptGroup = { attempt, events: [], sessionIds: new Set(), requestIds: new Set(), taskIds: new Set() };
      dispatch.attempts.set(attempt, attemptGroup);
    }
    attemptGroup.events.push(event);
    attemptGroup.sessionIds.add(sessionId);
    attemptGroup.requestIds.add(requestId);
    if (taskId) attemptGroup.taskIds.add(taskId);
  }
  if (!hasRequest || !hasAck || !hasResult || !hasCancelled || !hasFailed || requestIds.size < 2 || dispatchesById.size < 2) return fail('B3 raw events do not prove independent cancellation plus a failed/retried dispatch with request/ACK/RESULT evidence', 'BAD_EVENTS');
  if ((taskIdEvents > 0 && (taskIdEvents !== actionEvents.length || taskIds.size !== 1)) || taskIds.size > 1 || (spec.taskId !== undefined && (!String(spec.taskId).trim() || taskIdEvents !== actionEvents.length || [...taskIds].some(taskId => taskId !== String(spec.taskId)))) ) return fail('B3 taskId is not consistent across the joined event trace', 'IDENTITY_JOIN_FAILED');
  for (const dispatch of dispatchesById.values()) {
    for (const group of dispatch.attempts.values()) {
      if (group.sessionIds.size !== 1 || group.requestIds.size !== 1 || group.taskIds.size > 1) return fail('B3 one dispatch attempt is joined to multiple session/request/task identities', 'IDENTITY_JOIN_FAILED');
    }
  }
  const retryDispatchId = spec.retry.dispatchId === undefined ? '' : String(spec.retry.dispatchId);
  let retryDispatch = retryDispatchId ? dispatchesById.get(retryDispatchId) : null;
  if (retryDispatchId && !retryDispatch) return fail('B3 explicit retry dispatchId does not identify the event stream', 'IDENTITY_JOIN_FAILED');
  if (!retryDispatch) {
    const candidates = [...dispatchesById.values()].filter(dispatch => dispatch.attempts.has(currentAttempt));
    if (spec.retry.sessionId !== undefined) {
      const session = String(spec.retry.sessionId);
      retryDispatch = candidates.find(dispatch => dispatch.attempts.get(currentAttempt)?.sessionIds.has(session));
    }
    if (!retryDispatch) {
      const retried = candidates.filter(dispatch => dispatch.attempts.size >= 2);
      if (retried.length === 1) retryDispatch = retried[0];
    }
    if (!retryDispatch && candidates.length === 1) retryDispatch = candidates[0];
  }
  if (!retryDispatch) return fail('B3 failed/retried dispatch cannot be identified unambiguously', 'RETRY_NOT_PROVEN');
  const dispatchId = retryDispatch.dispatchId;
  if (currentAttempt !== 2) return fail('B3 each dispatch may have at most one explicit retry', 'RETRY_NOT_PROVEN');
  const expectedAttempts = Array.from({ length: currentAttempt }, (_, index) => index + 1);
  if (retryDispatch.attempts.size !== currentAttempt || expectedAttempts.some(attempt => !retryDispatch.attempts.has(attempt))) return fail('B3 retry attempts must be contiguous and each have one request identity', 'RETRY_NOT_PROVEN');
  const requestsByAttempt = new Map();
  const sessionsByAttempt = new Map();
  const tasksByAttempt = new Map();
  const attemptGroup = (dispatch, attempt) => dispatch.attempts.get(attempt);
  for (const attempt of expectedAttempts) {
    const group = attemptGroup(retryDispatch, attempt);
    requestsByAttempt.set(attempt, [...group.requestIds][0]);
    sessionsByAttempt.set(attempt, [...group.sessionIds][0]);
    tasksByAttempt.set(attempt, [...group.taskIds][0] || '');
  }
  if (new Set(requestsByAttempt.values()).size !== 1) return fail('B3 retry attempts must preserve one requestId for the dispatch', 'STALE_ATTEMPT');
  if (sessionsByAttempt.get(1) === sessionsByAttempt.get(currentAttempt)) return fail('B3 an explicit retry must create a new session', 'IDENTITY_JOIN_FAILED');
  if (spec.retry.requestId !== undefined && String(spec.retry.requestId) !== requestsByAttempt.get(currentAttempt)) return fail('B3 explicit retry requestId does not identify the current attempt', 'STALE_ATTEMPT');
  if (spec.retry.sessionId !== undefined && String(spec.retry.sessionId) !== sessionsByAttempt.get(currentAttempt)) return fail('B3 explicit retry sessionId does not identify the current attempt', 'IDENTITY_JOIN_FAILED');
  if (spec.retry.taskId !== undefined && String(spec.retry.taskId) !== tasksByAttempt.get(currentAttempt)) return fail('B3 explicit retry taskId does not identify the current attempt', 'IDENTITY_JOIN_FAILED');
  const currentRequestId = requestsByAttempt.get(currentAttempt);
  const actionGroupEvents = (dispatch, attempt) => attemptGroup(dispatch, attempt)?.events || [];
  const validateAttempt = (dispatch, attempt, { retry = false } = {}) => {
    const group = attemptGroup(dispatch, attempt);
    if (!group) return fail(`B3 dispatch ${dispatch.dispatchId} is missing attempt ${attempt}`, 'RETRY_NOT_PROVEN');
    const requestId = [...group.requestIds][0];
    const sessionId = [...group.sessionIds][0];
    const taskId = [...group.taskIds][0] || '';
    const attemptEvents = group.events;
    const requests = attemptEvents.filter(event => eventKind(event).includes('request'));
    const acks = attemptEvents.filter(event => eventKind(event).includes('ack') || eventKind(event).includes('running'));
    const terminals = attemptEvents.filter(event => TERMINAL.has(String(event?.status || '').toLowerCase()));
    if (requests.length !== 1 || acks.length !== 1 || terminals.length !== 1) return fail('B3 each request attempt must have exactly one request, ACK, and terminal event', 'TERMINAL_NOT_UNIQUE');
    for (const event of [...requests, ...acks, ...terminals]) {
      if (String(event?.dispatchId || '') !== dispatch.dispatchId || String(event?.sessionId || '') !== sessionId || String(event?.requestId || '') !== requestId || (taskId && String(event?.taskId || '') !== taskId)) return fail('B3 event is not joined to its dispatch/session/request/task attempt identity', 'IDENTITY_JOIN_FAILED');
    }
    if (String(acks[0]?.replyTo || '') !== requestId) return fail('B3 ACK is not joined to its requestId/attempt', 'IDENTITY_JOIN_FAILED');
    if (String(terminals[0]?.replyTo || '') !== requestId) return fail('B3 terminal event is not joined to its requestId/attempt', 'STALE_ATTEMPT');
    if (!retry && String(terminals[0].status).toLowerCase() !== 'cancelled') return fail('B3 independent dispatch must have one cancelled terminal attempt', 'BAD_EVENTS');
    return { ok: true, requestId, sessionId, taskId, terminal: terminals[0], result: attemptEvents.filter(event => eventKind(event).includes('result')) };
  };
  for (const attempt of expectedAttempts) {
    const checked = validateAttempt(retryDispatch, attempt, { retry: true });
    if (!checked.ok) return checked;
  }
  for (const dispatch of dispatchesById.values()) {
    if (dispatch === retryDispatch) continue;
    if (dispatch.attempts.size !== 1 || !dispatch.attempts.has(1)) return fail('B3 independent dispatches may not contain a second attempt', 'STALE_ATTEMPT');
    const checked = validateAttempt(dispatch, 1);
    if (!checked.ok) return checked;
  }
  if ([...dispatchesById.values()].filter(dispatch => dispatch !== retryDispatch).length !== 1) return fail('B3 evidence must contain exactly one independent cancellation dispatch', 'BAD_EVENTS');
  const priorChecked = validateAttempt(retryDispatch, currentAttempt - 1, { retry: true });
  if (!priorChecked.ok) return priorChecked;
  if (!['failed', 'cancelled'].includes(String(priorChecked.terminal.status).toLowerCase())) return fail('B3 explicit retry must follow a failed or cancelled prior attempt', 'RETRY_NOT_PROVEN');
  const currentChecked = validateAttempt(retryDispatch, currentAttempt, { retry: true });
  if (!currentChecked.ok || currentChecked.result.length !== 1 || String(currentChecked.terminal.status).toLowerCase() !== 'succeeded' || currentChecked.result[0] !== currentChecked.terminal) return fail('B3 current retry attempt must have one successful RESULT bound to its own requestId', 'STALE_ATTEMPT');
  const currentAttemptEvents = actionGroupEvents(retryDispatch, currentAttempt);
  const currentResults = currentAttemptEvents.filter(event => eventKind(event).includes('result'));
  if (currentResults.length !== 1 || String(currentResults[0].status || '').toLowerCase() !== 'succeeded' || currentResults[0].requestId !== currentRequestId) return fail('B3 current retry attempt must have one successful RESULT bound to its own requestId', 'STALE_ATTEMPT');
  const terminal = actionEvents.filter(event => TERMINAL.has(String(event?.status || '').toLowerCase()));
  const dispatches = effects.filter(event => eventKind(event).includes('dispatch'));
  const writes = effects.filter(event => eventKind(event).includes('write') || eventKind(event).includes('side-effect'));
  if (dispatches.length < 2 || writes.length !== 1) return fail('B3 raw side-effects log does not prove repeated dispatch with one write', 'DUPLICATE_SIDE_EFFECT');
  const effectsByDispatch = new Map();
  for (const dispatch of dispatches) {
    const effectDispatchId = String(dispatch?.dispatchId || '');
    const eventDispatch = dispatchesById.get(effectDispatchId);
    if (!effectDispatchId || !eventDispatch) return fail('B3 side-effect dispatch is joined to an unknown dispatchId', 'IDENTITY_JOIN_FAILED');
    if (!effectsByDispatch.has(effectDispatchId)) effectsByDispatch.set(effectDispatchId, []);
    effectsByDispatch.get(effectDispatchId).push(dispatch);
    const effectAttempt = dispatch.attempt;
    if (effectAttempt !== undefined && (!Number.isSafeInteger(effectAttempt) || !eventDispatch.attempts.has(effectAttempt))) return fail('B3 side-effect dispatch has a stale attempt join', 'STALE_ATTEMPT');
    if (dispatch.sessionId !== undefined || dispatch.requestId !== undefined || dispatch.taskId !== undefined) {
      const matchingAttempts = [...eventDispatch.attempts.entries()].filter(([, group]) => {
        const sessionMatches = dispatch.sessionId === undefined || [...group.sessionIds][0] === String(dispatch.sessionId);
        const requestMatches = dispatch.requestId === undefined || [...group.requestIds][0] === String(dispatch.requestId);
        const taskMatches = dispatch.taskId === undefined || [...group.taskIds][0] === String(dispatch.taskId);
        return sessionMatches && requestMatches && taskMatches && (effectAttempt === undefined || group.attempt === effectAttempt);
      });
      if (matchingAttempts.length !== 1) return fail('B3 side-effect dispatch is joined to a stale session/request/task identity', 'IDENTITY_JOIN_FAILED');
    }
  }
  for (const eventDispatch of dispatchesById.values()) {
    const effectRows = effectsByDispatch.get(eventDispatch.dispatchId) || [];
    if (eventDispatch === retryDispatch && effectRows.length < 2) return fail('B3 retried dispatch is missing its repeated idempotent side-effect record', 'DUPLICATE_SIDE_EFFECT');
    if (eventDispatch !== retryDispatch && effectRows.length !== 1) return fail('B3 independent cancellation dispatch must have exactly one side-effect record', 'DUPLICATE_SIDE_EFFECT');
    const keys = new Set(effectRows.map(event => String(event?.idempotencyKey || event?.dispatchId || '')).filter(Boolean));
    if (keys.size !== 1) return fail('B3 repeated dispatches for one operation do not share one idempotency key', 'DUPLICATE_SIDE_EFFECT');
  }
  for (const write of writes) {
    if (write.dispatchId !== undefined && String(write.dispatchId) !== dispatchId) return fail('B3 result write is joined to a different dispatchId', 'IDENTITY_JOIN_FAILED');
    if (write.sessionId !== undefined && String(write.sessionId) !== sessionsByAttempt.get(currentAttempt)) return fail('B3 result write is joined to a different sessionId', 'IDENTITY_JOIN_FAILED');
    if (write.requestId !== undefined && String(write.requestId) !== currentRequestId) return fail('B3 result write is joined to a stale requestId', 'STALE_ATTEMPT');
    if (write.attempt !== undefined && write.attempt !== currentAttempt) return fail('B3 result write is joined to a stale attempt', 'STALE_ATTEMPT');
  }
  const resultPath = requireFile(spec.resultPath, 'B3 result artifact', [isolatedRoot]);
  if (!resultPath.ok) return resultPath;
  const resultSha = requireHash(spec.resultSha256, 'B3 result artifact sha256');
  if (!resultSha.ok) return resultSha;
  if (fileSha256(resultPath.path) !== spec.resultSha256.toLowerCase()) return fail('B3 result artifact hash does not match disk', 'HASH_MISMATCH');
  if (!writes.some(event => path.resolve(String(event?.path || '')) === resultPath.path && String(event?.sha256 || '').toLowerCase() === spec.resultSha256.toLowerCase())) return fail('B3 raw side-effects log does not identify the one result write and its hash', 'WRITE_NOT_PROVEN');
  const executionLog = readText(executionRef.path);
  if (!/codex/i.test(executionLog) || !/claude/i.test(executionLog)) return fail('B3 raw execution log does not record the requested Codex-to-Claude route', 'RUNTIME_ROUTE_NOT_PROVEN');
  return pass('B3 raw event/effect logs and result bytes pass mechanical checks; runtime truth remains an independent-review question', {
    mechanical: 'pass', reviewRequired: true, dispatchId, sessionId: sessionsByAttempt.get(currentAttempt), currentRequestId, currentAttempt, sequenceCount: events.length,
    attempts: terminal.length, dispatches: dispatches.length, writes: writes.length, resultPath: resultPath.path,
  });
}

export function checkB4(run) {
  const spec = run?.categories?.B4;
  const isolatedRoot = absolutePath(run?.isolatedRoot);
  if (spec?.status === 'skip' || spec?.notApplicable === true) return fail('B4 is a required scored learning scenario; only the taught rule may be skipped in the non-applicable scene', 'B4_REQUIRED');
  if (!spec || typeof spec !== 'object' || !isolatedRoot) return notRun('B4 evidence is missing (NOT_RUN)', 'NOT_RUN');
  const roots = [isolatedRoot, absolutePath(run?.evidenceRoot)].filter(Boolean);
  const traceRef = verifyFileRef(spec.traceEvidence, 'B4 raw trace', roots, { nonEmpty: true });
  const beforeRef = verifyFileRef(spec.stateBeforeEvidence, 'B4 state-before', roots, { nonEmpty: true });
  const restoredRef = verifyFileRef(spec.stateRestoredEvidence, 'B4 restored state', roots, { nonEmpty: true });
  const feedbackRef = verifyFileRef(spec.feedbackEvidence, 'B4 feedback', roots, { nonEmpty: true });
  if (!traceRef.ok) return traceRef;
  if (!beforeRef.ok) return beforeRef;
  if (!restoredRef.ok) return restoredRef;
  if (!feedbackRef.ok) return feedbackRef;
  if (!spec.ruleId || typeof spec.ruleId !== 'string' || !spec.ruleId.trim()) return fail('B4 ruleId is required', 'BAD_B4_TRACE');
  if (!['project', 'task'].includes(spec.scope)) return fail('B4 taught rule must declare project/task scope', 'BAD_SCOPE');
  let trace;
  try { trace = readJsonLines(traceRef.path, 'B4 raw trace'); }
  catch (error) { return fail(error.message, 'BAD_RAW_LOG'); }
  const beforeState = readJsonFile(beforeRef.path, 'B4 state-before');
  const restoredState = readJsonFile(restoredRef.path, 'B4 restored state');
  if (!beforeState.ok) return beforeState;
  if (!restoredState.ok) return restoredState;
  const projection = state => {
    const rules = Array.isArray(state.rules) ? state.rules : [];
    const matches = rules.filter(rule => String(rule?.id || '') === spec.ruleId);
    if (matches.length !== 1) return { ok: false, message: `B4 state must contain exactly one effective rule with id ${spec.ruleId}` };
    const rule = matches[0];
    if (typeof rule.scope !== 'string' || !rule.scope.trim() || rule.scope === 'global' || typeof rule.status !== 'string' || !rule.status.trim()) return { ok: false, message: 'B4 effective rule projection requires id, non-global scope, and status' };
    const versionKeys = ['version', 'ruleVersion', 'revision'].filter(key => Object.prototype.hasOwnProperty.call(rule, key));
    const contentKeys = ['contentContract', 'content', 'text', 'description', 'pattern', 'when', 'then', 'action'].filter(key => Object.prototype.hasOwnProperty.call(rule, key));
    const projectValues = keys => {
      if (keys.length === 0) return null;
      if (keys.length === 1) return canonicalJson(rule[keys[0]]);
      return Object.fromEntries(keys.map(key => [key, canonicalJson(rule[key])]));
    };
    const result = {
      id: spec.ruleId,
      scope: rule.scope,
      status: rule.status,
      version: projectValues(versionKeys),
      content: projectValues(contentKeys),
    };
    const emptyValue = value => value === null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0) || (value && typeof value === 'object' && Object.keys(value).length === 0);
    if (versionKeys.length > 0 && (emptyValue(result.version) || !['string', 'number', 'object'].includes(typeof result.version) || (typeof result.version === 'number' && (!Number.isSafeInteger(result.version) || result.version < 1)))) return { ok: false, message: 'B4 effective rule version is invalid' };
    if (contentKeys.length > 0 && emptyValue(result.content)) return { ok: false, message: 'B4 effective rule content contract is empty' };
    return { ok: true, value: result };
  };
  const beforeProjection = projection(beforeState.value);
  const restoredProjection = projection(restoredState.value);
  if (!beforeProjection.ok) return fail(beforeProjection.message, 'BAD_RULE_PROJECTION');
  if (!restoredProjection.ok) return fail(restoredProjection.message, 'BAD_RULE_PROJECTION');
  if (beforeProjection.value.scope !== spec.scope || restoredProjection.value.scope !== spec.scope) return fail('B4 effective rule projection scope does not match the declared scope', 'BAD_SCOPE');
  if (!sameJson(beforeProjection.value, restoredProjection.value)) return fail('B4 restore did not recover the documented effective rule projection', 'RESTORE_MISMATCH');
  const beforeAudit = Array.isArray(beforeState.value.audit) ? beforeState.value.audit : null;
  const restoredAudit = Array.isArray(restoredState.value.audit) ? restoredState.value.audit : null;
  if (!beforeAudit || !restoredAudit || restoredAudit.length <= beforeAudit.length || beforeAudit.some((entry, index) => !sameJson(canonicalJson(entry), canonicalJson(restoredAudit[index])))) return fail('B4 restored state must preserve the original audit prefix and append new history', 'AUDIT_NOT_APPEND_ONLY');
  const kinds = trace.map(eventKind);
  const required = ['teach', 'scene', 'skip', 'counterexample', 'restore', 'feedback'];
  const positions = Object.fromEntries(required.map(kind => [kind, kinds.findIndex(value => value.includes(kind))]));
  const supersedeIndex = kinds.findIndex(value => value.includes('supersede') || value.includes('disable'));
  if (supersedeIndex < 0) return fail('B4 raw trace is missing supersede/disable', 'BAD_B4_TRACE');
  if (required.some(kind => positions[kind] < 0) || positions.teach > positions.scene || positions.scene > positions.skip || positions.skip > positions.counterexample || positions.counterexample > supersedeIndex || supersedeIndex > positions.restore || positions.restore > positions.feedback) return fail('B4 raw trace does not preserve teach → non-applicable skip → counterexample → supersede/disable → restore → feedback order', 'BAD_B4_TRACE');
  const teach = trace[positions.teach];
  const scene = trace[positions.scene];
  const skipped = trace[positions.skip];
  const counterexample = trace[positions.counterexample];
  const supersede = trace[supersedeIndex];
  const restored = trace[positions.restore];
  const feedbackEvent = trace[positions.feedback];
  if (String(teach.ruleId) !== spec.ruleId || teach.scope !== spec.scope || typeof scene.sceneId !== 'string' || scene.applies !== false || String(skipped.ruleId) !== spec.ruleId || skipped.scope !== spec.scope || skipped.applies !== false || skipped.unrelatedRulesEligible !== true || String(counterexample.ruleId) !== spec.ruleId || typeof counterexample.evidenceRef !== 'string' || String(supersede.ruleId) !== spec.ruleId || String(restored.ruleId) !== spec.ruleId || String(feedbackEvent.ruleId) !== spec.ruleId) return fail('B4 trace does not prove a scoped rule, scene-local skip, unrelated-rule eligibility, counterexample, and recovery', 'BAD_B4_SCOPE');
  const feedback = readText(feedbackRef.path);
  if (!feedback.includes(spec.ruleId) || !/feedback|outcome|useful|supersede|disable/i.test(feedback)) return fail('B4 feedback artifact is missing rule-linked outcome evidence', 'BAD_FEEDBACK');
  const restoredTailKinds = restoredAudit.slice(beforeAudit.length).map(eventKind);
  const historyText = [...restoredTailKinds, ...kinds, feedback.toLowerCase()].join(' ');
  for (const kind of ['counterexample', 'restore', 'feedback']) if (!historyText.includes(kind)) return fail(`B4 append-only history is missing ${kind} evidence`, 'AUDIT_INCOMPLETE');
  if (!historyText.includes('supersede') && !historyText.includes('disable')) return fail('B4 append-only history is missing supersede/disable evidence', 'AUDIT_INCOMPLETE');
  return pass('B4 raw trace and state artifacts pass mechanical sequence/scope/restore checks; semantic learning quality requires independent review', {
    mechanical: 'pass', reviewRequired: true, ruleId: spec.ruleId, scope: spec.scope, effectiveProjection: restoredProjection.value, auditAppended: restoredAudit.length - beforeAudit.length, trace: traceRef.path,
  });
}

function checkB5(run) {
  const spec = run?.categories?.B5;
  const isolatedRoot = absolutePath(run?.isolatedRoot);
  if (!spec || typeof spec !== 'object' || !isolatedRoot) return notRun('B5 source lookup evidence is missing (NOT_RUN)', 'NOT_RUN');
  const roots = [isolatedRoot, absolutePath(run?.evidenceRoot)].filter(Boolean);
  if (spec.lookupPerformed !== true || spec.task?.requiresCsvParsing !== true || !Array.isArray(spec.sources) || spec.sources.length === 0) return notRun('B5 requires a genuinely CSV-shaped task and source list (NOT_RUN)', 'NOT_RUN');
  const promptRef = verifyFileRef(spec.task.promptEvidence, 'B5 task prompt', roots, { nonEmpty: true });
  const csvRef = verifyFileRef(spec.task.csvInputEvidence, 'B5 CSV input', roots, { nonEmpty: true });
  const lookupRef = verifyFileRef(spec.lookupEvidence, 'B5 raw lookup log', roots, { nonEmpty: true });
  const decisionRef = verifyFileRef(spec.decisionEvidence, 'B5 decision log', roots, { nonEmpty: true });
  if (!promptRef.ok) return promptRef;
  if (!csvRef.ok) return csvRef;
  if (!lookupRef.ok) return lookupRef;
  if (!decisionRef.ok) return decisionRef;
  if (!/\.csv$/i.test(csvRef.path) || !/csv/i.test(readText(promptRef.path))) return fail('B5 task artifacts do not prove a CSV parsing requirement', 'BAD_TASK_FIXTURE');
  const allowed = new Set(['github.com', 'www.github.com', 'raw.githubusercontent.com', 'huggingface.co', 'www.huggingface.co']);
  for (const source of spec.sources) {
    if (!source || typeof source !== 'object' || !source.url || !source.version || !source.license || !source.decision || !source.decisionReason || !source.recheckTrigger) return fail('B5 source requires URL, version, license, decisionReason, and recheckTrigger', 'BAD_SOURCE');
    let url;
    try { url = new URL(source.url); } catch { return fail(`B5 source URL is invalid: ${source.url}`, 'BAD_SOURCE'); }
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || !allowed.has(url.hostname.toLowerCase()) || pathParts.length < 2) return fail(`B5 source is not an allowed official/maintainer GitHub or Hugging Face URL: ${source.url}`, 'BAD_SOURCE');
    if (!['adopt', 'adapt', 'reject'].includes(String(source.decision).toLowerCase())) return fail('B5 decision must be adopt, adapt, or reject', 'BAD_SOURCE');
    const capture = verifyFileRef(source.captureEvidence, `B5 source capture ${source.url}`, roots, { nonEmpty: true });
    if (!capture.ok) return capture;
    if (!readText(lookupRef.path).includes(source.url) || !readText(capture.path).trim()) return fail(`B5 raw lookup/capture does not contain ${source.url}`, 'SOURCE_NOT_PROVEN');
  }
  const decisionLog = readText(decisionRef.path);
  if (!/adopt|adapt|reject/i.test(decisionLog) || !/recheck/i.test(decisionLog)) return fail('B5 decision artifact is incomplete', 'BAD_SOURCE_DECISION');
  return pass('B5 task, raw lookup, captures, and decision artifacts pass mechanical checks; source authenticity/license and reuse quality require independent review', { mechanical: 'pass', reviewRequired: true, sourceCount: spec.sources.length });
}

function checkB6(run) {
  const spec = run?.categories?.B6;
  const isolatedRoot = absolutePath(run?.isolatedRoot);
  if (!spec || typeof spec !== 'object' || !isolatedRoot) return notRun('B6 backend/UI evidence is missing (NOT_RUN)', 'NOT_RUN');
  const roots = [isolatedRoot, absolutePath(run?.evidenceRoot)].filter(Boolean);
  const backendRef = verifyFileRef(spec.backendEvidence, 'B6 backend observation', roots, { nonEmpty: true });
  const uiRef = verifyFileRef(spec.uiEvidence, 'B6 UI observation', roots, { nonEmpty: true });
  const stateRef = verifyFileRef(spec.canonicalStateEvidence, 'B6 canonical task/index state', roots, { nonEmpty: true });
  const screenshotRef = verifyFileRef(spec.screenshotEvidence, 'B6 UI screenshot/visual artifact', roots, { nonEmpty: true });
  if (!backendRef.ok) return backendRef;
  if (!uiRef.ok) return uiRef;
  if (!stateRef.ok) return stateRef;
  if (!screenshotRef.ok) return screenshotRef;
  if (!/\.(png|jpe?g|webp)$/i.test(screenshotRef.path)) return fail('B6 screenshot evidence must be an image artifact', 'BAD_UI_ARTIFACT');
  const image = validImageBytes(screenshotRef.path);
  if (!image.ok) return fail(`B6 screenshot is not accepted: ${image.message}`, image.code || 'IMAGE_NOT_DECODABLE');
  const backend = readJsonFile(backendRef.path, 'B6 backend observation');
  const ui = readJsonFile(uiRef.path, 'B6 UI observation');
  if (!backend.ok) return backend;
  if (!ui.ok) return ui;
  const b = backend.value;
  const u = ui.value;
  const projectRoot = absolutePath(b.projectRoot);
  if (!projectRoot || !pathInside(isolatedRoot, projectRoot) || projectRoot !== absolutePath(u.projectRoot) || String(b.taskId || '') !== String(u.taskId || '')) return fail('B6 raw backend/UI artifacts do not identify one canonical project/task', 'TASK_MISMATCH');
  let url;
  try { url = new URL(b.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('bad protocol'); } catch { return fail('B6 raw backend observation URL is invalid', 'BAD_BACKEND'); }
  const canonicalPath = absolutePath(b.canonicalStatePath);
  if (!canonicalPath || canonicalPath !== absolutePath(u.canonicalStatePath) || !pathInside(projectRoot, canonicalPath) || canonicalPath !== stateRef.path) return fail('B6 canonical state path is not shared by CLI and UI artifacts', 'STATE_NOT_PROVEN');
  const canonicalSha = fileSha256(canonicalPath);
  if (b.canonicalStateSha256 !== canonicalSha || u.canonicalStateSha256 !== canonicalSha) return fail('B6 canonical state hashes do not match disk', 'HASH_MISMATCH');
  if (b.startedFromCli !== true || b.openBrowser !== false || u.observedAfterCli !== true || !b.lock || !['started', 'reused'].includes(b.lock.mode) || b.lock.acquired !== true) return fail('B6 raw artifacts do not prove CLI-only backend start/reuse and lock evidence', 'BAD_OBSERVATION');
  if (String(u.url || b.url) !== b.url || String(u.api?.projectRoot || '') !== projectRoot || String(u.api?.taskId || '') !== String(b.taskId)) return fail('B6 UI/API raw observation does not agree with the CLI canonical task', 'API_UI_MISMATCH');
  return pass('B6 raw CLI/UI observations, canonical state hash, and decodable visual artifact pass mechanical checks; browser truth requires independent review', { mechanical: 'pass', reviewRequired: true, image: { format: image.format, width: image.width, height: image.height }, projectRoot, taskId: String(b.taskId), url: b.url, canonicalSha256: canonicalSha });
}

function checkMetadata(run) {
  const required = ['sourceSha', 'packageHash', 'isolatedRoot', 'evidenceRoot', 'runtime', 'model', 'effort', 'startedAt', 'endedAt'];
  const missing = required.filter(key => typeof run?.[key] !== 'string' || !run[key].trim() || ['unknown', 'unrecorded'].includes(run[key].trim().toLowerCase()));
  if (missing.length) return notRun(`run metadata is missing: ${missing.join(', ')}`, 'NOT_RUN');
  if (!['smoke', 'full'].includes(run.resultType)) return fail('resultType must be explicitly smoke or full', 'BAD_METADATA');
  if (!/^[a-f0-9]{7,64}$/i.test(run.sourceSha)) return fail('sourceSha must be a Git SHA', 'BAD_METADATA');
  if (!/^[a-f0-9]{64}$/i.test(run.packageHash)) return fail('packageHash must be a SHA-256 digest', 'BAD_METADATA');
  if (!path.isAbsolute(run.isolatedRoot) || !path.isAbsolute(run.evidenceRoot)) return fail('isolatedRoot and evidenceRoot must be absolute paths', 'BAD_METADATA');
  if (!isDirectory(run.isolatedRoot) || !isDirectory(run.evidenceRoot)) return notRun('isolatedRoot and evidenceRoot must be existing directories (NOT_RUN)', 'NOT_RUN');
  if (path.resolve(run.isolatedRoot) === path.resolve(SCRIPT_ROOT) || pathInside(SCRIPT_ROOT, run.isolatedRoot)) return fail('isolatedRoot must be a fresh directory outside the development repository', 'DEVELOPMENT_REPO_LEAK');
  if (pathInside(SCRIPT_ROOT, run.evidenceRoot)) return fail('evidenceRoot must be outside the development repository', 'DEVELOPMENT_REPO_LEAK');
  if (!run.evidenceSource || typeof run.evidenceSource !== 'object' || typeof run.evidenceSource.kind !== 'string' || !run.evidenceSource.kind.trim() || typeof run.evidenceSource.root !== 'string' || path.resolve(run.evidenceSource.root) !== path.resolve(run.evidenceRoot) || typeof run.evidenceSource.capturedAt !== 'string' || typeof run.evidenceSource.capturedBy !== 'string') return fail('evidenceSource must identify the fresh artifact root, capture time, and capture actor', 'BAD_EVIDENCE_SOURCE');
  if (!Array.isArray(run.steps) || run.steps.length === 0) return notRun('steps evidence is missing (NOT_RUN)', 'NOT_RUN');
  for (const [index, step] of run.steps.entries()) {
    if (!step || typeof step !== 'object' || typeof step.command !== 'string' || !step.command.trim() || typeof step.status !== 'string' || !RESULT_STATUSES.has(step.status) || typeof step.startedAt !== 'string' || typeof step.endedAt !== 'string' || typeof step.source !== 'string' || !Array.isArray(step.evidencePaths) || step.evidencePaths.some(value => typeof value !== 'string' || !path.isAbsolute(value))) return fail(`steps[${index}] must record command, status, timestamps, source, and absolute evidencePaths`, 'BAD_STEPS');
  }
  for (const key of ['rework', 'recovery', 'duplicateSideEffects']) if (!Number.isInteger(run[key]) || run[key] < 0) return fail(`${key} must be a non-negative integer`, 'BAD_REPORT');
  if (!run.providerMeasured || !run.estimated) return fail('estimated/providerMeasured metrics must remain separate', 'BAD_REPORT');
  for (const key of ['tokens', 'cost']) {
    const value = key === 'tokens'
      ? (run.providerMeasured.tokens ?? run.providerMeasured.token)
      : run.providerMeasured[key];
    if (value !== 'unknown' && (!Number.isFinite(value) || value < 0)) return fail(`providerMeasured.${key} must be a number or unknown`, 'BAD_TELEMETRY');
  }
  return pass('run metadata and telemetry fields are present');
}

function checkIndependentReview(run) {
  const review = run?.independentReview;
  if (!review || typeof review !== 'object') return notRun('independent review evidence is missing (NOT_RUN)', 'NOT_RUN');
  if (!REVIEW_STATUSES.has(review.status)) return fail('independentReview.status must be pass, pending, or fail', 'BAD_REVIEW');
  if (review.status === 'pending') return pending('independent manual review is still pending; overall pass is blocked', 'REVIEW_PENDING');
  if (review.status === 'fail') return fail('independent manual review rejected the run', 'REVIEW_FAILED');
  if (review.independent !== true || review.executorDistinct !== true || review.method !== 'manual-independent-review' || typeof review.reviewerId !== 'string' || !review.reviewerId.trim() || typeof review.reviewedAt !== 'string') return fail('independent review must identify a distinct reviewer and manual review method', 'BAD_REVIEW');
  const report = verifyFileRef(review.reportEvidence, 'independent review report', [absolutePath(run.evidenceRoot)].filter(Boolean), { nonEmpty: true });
  if (!report.ok) return report;
  const reportText = readText(report.path);
  if (!reportText.includes(BENCHMARK_ID) || !/B1|B2|B3|B4|B5|B6/.test(reportText) || !/pass|accept/i.test(reportText)) return fail('independent review report is not a category-by-category acceptance record', 'BAD_REVIEW_REPORT');
  if (!review.categories || typeof review.categories !== 'object') return fail('independent review must list every category', 'BAD_REVIEW');
  for (const id of ['B1', 'B2', 'B3', 'B4', 'B5', 'B6']) {
    if (review.categories[id]?.status !== 'pass' || !Array.isArray(review.categories[id]?.evidenceRefs) || review.categories[id].evidenceRefs.length === 0) return fail(`independent review is not a pass for ${id}`, 'REVIEW_INCOMPLETE');
  }
  return pass('independent category-by-category review is complete', { reportPath: report.path, reviewerId: review.reviewerId });
}

function checkBaseline(run) {
  const baseline = run?.baseline;
  if (!baseline || typeof baseline !== 'object') return notRun('baseline section is missing (NOT_RUN)', 'NOT_RUN');
  if (baseline.status === 'not_run') {
    if (typeof baseline.reason !== 'string' || !baseline.reason.trim() || typeof baseline.conditions !== 'string' || !baseline.conditions.trim()) return fail('baseline not_run requires a concrete reason and conditions', 'BAD_BASELINE');
    return pass('baseline was not feasible under the recorded conditions; no causal comparison is claimed', { status: 'not_run' });
  }
  if (baseline.status !== 'run' || typeof baseline.handoffPath !== 'string' || !path.isAbsolute(baseline.handoffPath)) return fail('baseline must record status run/not_run and an absolute handoffPath', 'BAD_BASELINE');
  if (baseline.sameFixture !== true || baseline.samePermissions !== true || typeof baseline.runtime !== 'string' || typeof baseline.model !== 'string' || typeof baseline.effort !== 'string') return fail('baseline must prove same fixture, permissions, runtime, model, and effort', 'BAD_BASELINE');
  const handoff = requireFile(baseline.handoffPath, 'baseline handoff', [absolutePath(run.isolatedRoot), absolutePath(run.evidenceRoot)].filter(Boolean));
  if (!handoff.ok) return handoff;
  return pass('same-condition ordinary-handoff baseline is recorded', { handoffPath: baseline.handoffPath });
}

export function scoreRun(run, fixtureRoot = DEFAULT_FIXTURE_ROOT) {
  const metadata = checkMetadata(run);
  const baseline = checkBaseline(run);
  const review = checkIndependentReview(run);
  const checks = {
    B1: checkB1(run, fixtureRoot),
    B2: checkB2(run, fixtureRoot),
    B3: checkB3(run),
    B4: checkB4(run),
    B5: checkB5(run),
    B6: checkB6(run),
  };
  const categories = Object.fromEntries(Object.entries(checks).map(([id, result]) => [id, {
    n: 1,
    pass: result.status === 'pass' ? 1 : 0,
    fail: result.status === 'fail' ? 1 : 0,
    notRun: result.status === 'not_run' ? 1 : 0,
    pending: result.status === 'pending' ? 1 : 0,
    skip: result.status === 'skip' ? 1 : 0,
    status: result.status,
    message: result.message,
    code: result.code || null,
    evidence: result.evidence || null,
  }]));
  const blockedCategories = Object.values(categories).filter(item => item.status !== 'pass').length;
  const failCount = Object.values(categories).reduce((sum, item) => sum + item.fail, 0) + (metadata.ok ? 0 : 1) + (baseline.ok ? 0 : 1) + (review.ok ? 0 : 1);
  return {
    schemaVersion: 1,
    benchmarkId: BENCHMARK_ID,
    resultType: run?.resultType || 'smoke',
    claimBoundary: 'Pre-registered B1-B6 fixture/oracle evidence only; no SOTA or world-leading claim.',
    sourceSha: run?.sourceSha || null,
    packageHash: run?.packageHash || null,
    isolatedRoot: run?.isolatedRoot || null,
    evidenceRoot: run?.evidenceRoot || null,
    evidenceSource: run?.evidenceSource || null,
    runtime: run?.runtime || null,
    model: run?.model || null,
    effort: run?.effort || null,
    startedAt: run?.startedAt || null,
    endedAt: run?.endedAt || null,
    steps: run?.steps || [],
    rework: run?.rework ?? null,
    recovery: run?.recovery ?? null,
    duplicateSideEffects: run?.duplicateSideEffects ?? null,
    estimated: run?.estimated || {},
    providerMeasured: run?.providerMeasured || { tokens: 'unknown', cost: 'unknown' },
    metadata: { status: metadata.status, message: metadata.message, code: metadata.code || null },
    baseline: { status: run?.baseline?.status || baseline.status, validationStatus: baseline.status, message: baseline.message, code: baseline.code || null, evidence: baseline.evidence || null },
    independentReview: { status: review.status, message: review.message, code: review.code || null, evidence: review.evidence || null },
    categories,
    totals: {
      n: 6,
      pass: Object.values(categories).reduce((sum, item) => sum + item.pass, 0),
      fail: failCount,
      notRun: Object.values(categories).reduce((sum, item) => sum + item.notRun, 0),
      pending: Object.values(categories).reduce((sum, item) => sum + item.pending, 0),
      skip: Object.values(categories).reduce((sum, item) => sum + item.skip, 0),
      blocked: blockedCategories,
    },
    status: failCount === 0 && blockedCategories === 0 ? 'pass' : 'fail',
  };
}

function parseArgs(argv) {
  const args = { fixtureRoot: DEFAULT_FIXTURE_ROOT, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--self-check') args.selfCheck = true;
    else if (arg === '--validate-fixture') args.validateFixture = true;
    else if (arg === '--oracle') args.oracle = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--fixture-root') args.fixtureRoot = path.resolve(argv[++index]);
    else if (arg === '--run' || arg === '--input') args.run = path.resolve(argv[++index]);
    else if (arg === '--output') args.output = path.resolve(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/harness-intelligence-bench.mjs --help
  node scripts/harness-intelligence-bench.mjs --validate-fixture [--fixture-root DIR]
  node scripts/harness-intelligence-bench.mjs --self-check
  node scripts/harness-intelligence-bench.mjs --oracle --run EVIDENCE.json [--fixture-root DIR] [--json] [--output REPORT.json]

The evaluator reads installed-candidate evidence and the operator's own
fixture only. It never reads a development task state or sealed holdout and
never creates agent work or successful results.`);
}

function selfCheck() {
  const fixture = validateFixture();
  if (!fixture.ok) throw new Error(`fixture self-check failed: ${fixture.message}`);
  const goodBase = evaluateB2Output({ currency: 'CNY', totalMinor: 1350 }, 1350);
  const goodChanged = evaluateB2Output({ currency: 'CNY', totalMinor: 1800 }, 1800);
  const bad = evaluateB2Output({ currency: 'CNY', totalMinor: 1350 }, 1800);
  const missing = checkB2({ isolatedRoot: path.join(DEFAULT_FIXTURE_ROOT, 'missing'), categories: { B2: { cliPath: 'missing.mjs' } } });
  const skippedB4 = checkB4({ isolatedRoot: path.join(DEFAULT_FIXTURE_ROOT, 'missing'), categories: { B4: { status: 'skip', notApplicable: true, reason: 'not applicable' } } });
  if (!goodBase.ok || !goodChanged.ok || bad.ok || missing.ok || skippedB4.ok || skippedB4.code !== 'B4_REQUIRED') throw new Error('mechanical oracle self-check failed');
  console.log(JSON.stringify({ ok: true, selfCheck: true, checks: ['fixture-complete', 'correct-B2-output', 'wrong-B2-output-fails', 'missing-B2-evidence-fails', 'whole-B4-skip-rejected'] }));
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || argv.length === 0) { printHelp(); return; }
  if (args.selfCheck) { selfCheck(); return; }
  if (args.validateFixture) {
    const result = validateFixture(args.fixtureRoot);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (!args.oracle || !args.run) throw new Error('--oracle and --run EVIDENCE.json are required');
  const run = readJson(args.run);
  const report = scoreRun(run, args.fixtureRoot);
  if (args.output) fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(args.json ? JSON.stringify(report, null, 2) : JSON.stringify(report));
  if (report.status !== 'pass') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) {
    console.error(`harness-intelligence-bench failed: ${error.message}`);
    process.exitCode = 1;
  }
}
