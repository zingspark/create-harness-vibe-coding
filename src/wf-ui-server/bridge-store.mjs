import fs from 'node:fs';
import path from 'node:path';
import { validateTaskId } from './security.mjs';

const MAX_BRIDGE_LIMIT = 1000;

function normalizeSessionId(sessionId) {
  const text = String(sessionId || '').trim();
  if (!validateTaskId(text)) throw new Error(`Invalid sessionId: ${sessionId}`);
  return text;
}

function bridgesRoot(projectRoot) {
  return path.join(projectRoot, 'Harness', 'a2a', 'bridges');
}

export function bridgeIdForSessions(leftSessionId, rightSessionId) {
  const left = normalizeSessionId(leftSessionId);
  const right = normalizeSessionId(rightSessionId);
  return [left, right].sort().join('__');
}

function bridgePath(projectRoot, bridgeId) {
  return path.join(bridgesRoot(projectRoot), `${bridgeId}.jsonl`);
}

function consumerStatePath(projectRoot, sessionId) {
  return path.join(bridgesRoot(projectRoot), 'consumers', `${normalizeSessionId(sessionId)}.json`);
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function appendJsonl(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(data)}\n`, 'utf8');
}

function readConsumerState(projectRoot, sessionId) {
  try {
    const filePath = consumerStatePath(projectRoot, sessionId);
    if (!fs.existsSync(filePath)) return { schemaVersion: 2, consumedThroughSeq: 0, consumedThroughByBridge: {}, consumedEntries: [] };
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const consumedThroughByBridge = {};
    if (raw?.consumedThroughByBridge && typeof raw.consumedThroughByBridge === 'object' && !Array.isArray(raw.consumedThroughByBridge)) {
      for (const [bridgeId, value] of Object.entries(raw.consumedThroughByBridge)) {
        const seq = Number(value);
        if (bridgeId && Number.isFinite(seq) && seq >= 0) consumedThroughByBridge[bridgeId] = Math.floor(seq);
      }
    }
    return {
      schemaVersion: 2,
      consumedThroughSeq: Math.max(0, Number(raw?.consumedThroughSeq) || 0),
      consumedThroughByBridge,
      consumedEntries: Array.isArray(raw?.consumedEntries)
        ? [...new Set(raw.consumedEntries.map(value => String(value || '').trim()).filter(Boolean))].slice(-5000)
        : [],
    };
  } catch {
    return { schemaVersion: 2, consumedThroughSeq: 0, consumedThroughByBridge: {}, consumedEntries: [] };
  }
}

function writeConsumerState(projectRoot, sessionId, state) {
  const filePath = consumerStatePath(projectRoot, sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    schemaVersion: 2,
    consumedThroughSeq: Math.max(0, Number(state.consumedThroughSeq) || 0),
    consumedThroughByBridge: Object.fromEntries(
      Object.entries(state.consumedThroughByBridge || {})
        .filter(([bridgeId, value]) => bridgeId && Number.isFinite(Number(value)) && Number(value) >= 0)
        .map(([bridgeId, value]) => [bridgeId, Math.floor(Number(value))]),
    ),
    consumedEntries: [...new Set(state.consumedEntries || [])].slice(-5000),
  }, null, 2)}\n`, 'utf8');
}

function entryCursor(entry) {
  return `${String(entry?.bridgeId || '')}:${Number(entry?.seq || 0)}`;
}

export function acknowledgeBridgeMessages(projectRoot, sessionId, consumedThroughSeq, consumedThroughByBridge = null) {
  const session = normalizeSessionId(sessionId);
  const requested = Number(consumedThroughSeq);
  const requestedByBridge = consumedThroughByBridge && typeof consumedThroughByBridge === 'object' && !Array.isArray(consumedThroughByBridge)
    ? Object.fromEntries(Object.entries(consumedThroughByBridge)
      .map(([bridgeId, value]) => [String(bridgeId || '').trim(), Number(value)])
      .filter(([bridgeId, value]) => bridgeId && Number.isFinite(value) && value >= 0)
      .map(([bridgeId, value]) => [bridgeId, Math.floor(value)]))
    : {};
  if ((!Number.isFinite(requested) || requested < 0) && Object.keys(requestedByBridge).length === 0) {
    return {
      sessionId: session,
      ack: false,
      consumed: false,
      consumedThroughSeq: readConsumerState(projectRoot, session).consumedThroughSeq,
      consumedCount: 0,
    };
  }
  const state = readConsumerState(projectRoot, session);
  const all = listBridgeMessagesForSession(projectRoot, session, {
    deliveryMode: 'wakeup',
    limit: MAX_BRIDGE_LIMIT,
    includeConsumed: true,
  }).entries;
  const consumedEntries = new Set(state.consumedEntries);
  const consumedThrough = { ...(state.consumedThroughByBridge || {}) };
  const hasPerBridgeRequest = Object.keys(requestedByBridge).length > 0;
  let consumedCount = 0;
  for (const entry of all) {
    const bridgeId = String(entry?.bridgeId || '').trim();
    const bridgeRequested = hasPerBridgeRequest
      ? (requestedByBridge[bridgeId] ?? null)
      : (Number.isFinite(requested) ? Math.floor(requested) : null);
    if (bridgeRequested !== null && Number(entry?.seq || 0) <= bridgeRequested) {
      const cursor = entryCursor(entry);
      if (!consumedEntries.has(cursor)) consumedCount += 1;
      consumedEntries.add(cursor);
      consumedThrough[bridgeId] = Math.max(Number(consumedThrough[bridgeId] || 0), bridgeRequested);
    }
  }
  const next = {
    consumedThroughSeq: Math.max(state.consumedThroughSeq, Number.isFinite(requested) ? Math.floor(requested) : 0),
    consumedThroughByBridge: consumedThrough,
    consumedEntries: [...consumedEntries],
  };
  writeConsumerState(projectRoot, session, next);
  return {
    sessionId: session,
    ack: true,
    consumed: true,
    consumedThroughSeq: next.consumedThroughSeq,
    consumedSeq: next.consumedThroughSeq,
    consumedThroughByBridge: next.consumedThroughByBridge,
    consumedCount,
  };
}

export function listBridgeMessages(projectRoot, { fromSessionId, toSessionId, limit = 200 } = {}) {
  const bridgeId = bridgeIdForSessions(fromSessionId, toSessionId);
  const max = Math.min(Math.max(Number(limit) || 200, 1), MAX_BRIDGE_LIMIT);
  const entries = readJsonl(bridgePath(projectRoot, bridgeId)).slice(-max);
  return {
    bridgeId,
    fromSessionId: normalizeSessionId(fromSessionId),
    toSessionId: normalizeSessionId(toSessionId),
    entries,
  };
}

// List bridge entries for any bridge this session participates in (used for
// wakeup reads and cross-peer request aggregation; spec 6.1, 5).
export function listBridgeMessagesForSession(projectRoot, sessionId, {
  deliveryMode = '',
  requestId = '',
  threadId = '',
  bridgeId = '',
  afterSeq = null,
  afterSeqByBridge = null,
  limit = 200,
  includeConsumed = false,
} = {}) {
  const session = normalizeSessionId(sessionId);
  const max = Math.min(Math.max(Number(limit) || 200, 1), MAX_BRIDGE_LIMIT);
  const dir = bridgesRoot(projectRoot);
  const entries = [];
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const bridgeId = file.slice(0, -'.jsonl'.length);
      if (!(bridgeId === session || bridgeId.startsWith(`${session}__`) || bridgeId.endsWith(`__${session}`))) continue;
      entries.push(...readJsonl(path.join(dir, file)));
    }
  }
  let filtered = entries;
  if (bridgeId) filtered = filtered.filter(entry => String(entry?.bridgeId || '') === String(bridgeId));
  if (deliveryMode) filtered = filtered.filter(entry => entry.deliveryMode === deliveryMode);
  if (requestId) filtered = filtered.filter(entry => entry.requestId === requestId);
  if (threadId) filtered = filtered.filter(entry => entry.threadId === threadId);
  const cursorByBridge = afterSeqByBridge && typeof afterSeqByBridge === 'object' && !Array.isArray(afterSeqByBridge)
    ? Object.fromEntries(Object.entries(afterSeqByBridge)
      .map(([bridgeId, value]) => [String(bridgeId || '').trim(), Number(value)])
      .filter(([bridgeId, value]) => bridgeId && Number.isFinite(value) && value >= 0))
    : {};
  if (Number.isFinite(Number(afterSeq)) || Object.keys(cursorByBridge).length > 0) {
    filtered = filtered.filter((entry) => {
      const bridgeId = String(entry?.bridgeId || '').trim();
      const cursor = cursorByBridge[bridgeId] ?? (Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : null);
      return cursor === null || Number(entry.seq || 0) > cursor;
    });
  }
  if (!includeConsumed) {
    const state = readConsumerState(projectRoot, session);
    const consumedEntries = new Set(state.consumedEntries);
    filtered = filtered.filter(entry => !consumedEntries.has(entryCursor(entry)));
  }
  filtered.sort((a, b) => {
    const tsA = String(a.ts || '');
    const tsB = String(b.ts || '');
    return tsA === tsB ? (Number(a.seq) || 0) - (Number(b.seq) || 0) : tsA.localeCompare(tsB);
  });
  const visible = filtered.slice(-max);
  const nextCursorByBridge = {};
  for (const entry of visible) {
    const bridgeId = String(entry?.bridgeId || '').trim();
    if (!bridgeId) continue;
    nextCursorByBridge[bridgeId] = Math.max(Number(nextCursorByBridge[bridgeId] || 0), Number(entry.seq || 0));
  }
  return { sessionId: session, entries: visible, cursorByBridge: nextCursorByBridge };
}

export function recordBridgeMessage(projectRoot, {
  fromSessionId,
  toSessionId,
  fromNodeId = '',
  toNodeId = '',
  data = '',
  source = 'session-input',
  messageId = '',
  threadId = '',
  topic = '',
  replyTo = '',
  requestId = '',
  toRole = '',
  contextRefs = [],
  deliveryMode = 'direct',
  recipientIndex = null,
  recipientCount = null,
} = {}) {
  const from = normalizeSessionId(fromSessionId);
  const to = normalizeSessionId(toSessionId);
  if (from === to) return null;
  const bridgeId = bridgeIdForSessions(from, to);
  const filePath = bridgePath(projectRoot, bridgeId);
  const current = readJsonl(filePath);
  // Message ids are the bridge-level idempotency key. Returning the original
  // persisted entry keeps retries from creating another mailbox sequence.
  if (messageId) {
    const existing = current.find(entry => entry.messageId === String(messageId));
    if (existing) return existing;
  }
  const entry = {
    seq: current.length + 1,
    ts: new Date().toISOString(),
    bridgeId,
    cursor: `${bridgeId}:${current.length + 1}`,
    messageId: String(messageId || ''),
    threadId: String(threadId || ''),
    topic: String(topic || ''),
    replyTo: String(replyTo || ''),
    requestId: String(requestId || ''),
    toRole: String(toRole || ''),
    contextRefs: Array.isArray(contextRefs) ? contextRefs : [],
    deliveryMode: String(deliveryMode || 'direct'),
    recipientIndex: Number.isFinite(Number(recipientIndex)) ? Number(recipientIndex) : null,
    recipientCount: Number.isFinite(Number(recipientCount)) ? Number(recipientCount) : null,
    fromSessionId: from,
    toSessionId: to,
    fromNodeId: String(fromNodeId || ''),
    toNodeId: String(toNodeId || ''),
    source,
    data: String(data || ''),
  };
  appendJsonl(filePath, entry);
  return entry;
}
