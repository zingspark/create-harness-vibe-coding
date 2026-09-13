import crypto from 'node:crypto';
import path from 'node:path';
import { RUNTIME_IDS } from './runtime-detector.mjs';
import { validateTaskId } from './security.mjs';

/**
 * The dispatch API is opt-in.  Keep its vocabulary in one small module so
 * legacy session creation can continue to use the older, permissive shape.
 */
export const DISPATCH_TRANSPORTS = new Set(['pty', 'chat']);
export const DISPATCH_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

function text(value) {
  return String(value ?? '').trim();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

/**
 * Canonical JSON used for duplicate-dispatch comparison.  Retry controls and
 * control-plane routing are deliberately excluded because they are transport
 * concerns, not work identity.
 */
export function dispatchFingerprint(payload = {}, normalized = {}) {
  const ignored = new Set([
    'retry', 'dispatchRetry', 'attempt', 'attachGraphNode',
    'controlPlaneUrl', 'controlPlaneToken', 'position', 'workerCapability',
    // Capability provenance is a server-construction concern.  Caller claims
    // must neither authorize a model nor split the canonical dispatch key.
    'modelCapability', 'supportedModels', 'modelCapabilitySourceKind',
    'modelCapabilityVerificationLevel',
  ]);
  const source = { ...payload, ...normalized };
  const comparable = Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => !ignored.has(key) && source[key] !== undefined)
      .map(([key, value]) => [key, value]),
  );
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(comparable))).digest('hex');
}

export function dispatchCanonicalKey({ projectRoot, taskId, dispatchId }) {
  return [path.resolve(String(projectRoot || '')), text(taskId), text(dispatchId)].join('\u0000');
}

/**
 * Validate and normalize only the opt-in dispatch envelope.  A runtime/model
 * selection is never replaced with a detected default once dispatchId is set.
 */
export function normalizeDispatchRequest(payload = {}, { projectRoot, defaultRuntime = 'codex' } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw unsupported('dispatch envelope must be a JSON object');
  }
  const dispatchId = text(payload.dispatchId);
  const taskId = text(payload.taskId);
  const runtime = text(payload.runtime);
  const model = text(payload.model);
  const effort = text(payload.effort).toLowerCase();
  const transport = text(payload.transport || 'pty').toLowerCase();
  const requestId = text(payload.requestId);
  const replyTo = text(payload.replyTo);

  if (!dispatchId || !validateTaskId(dispatchId)) throw bad('dispatchId is required and must be a safe identifier');
  if (!taskId || !validateTaskId(taskId)) throw bad('taskId is required and must be a safe identifier');
  if (!runtime) throw unsupported('runtime is required for dispatch');
  if (!RUNTIME_IDS.has(runtime)) throw unsupported(`Unsupported runtime '${runtime}'`);
  if (!model) throw unsupported('model is required for dispatch');
  if (!DISPATCH_EFFORTS.has(effort)) throw unsupported(`Unsupported effort '${effort || '(empty)'}'`);
  if (!DISPATCH_TRANSPORTS.has(transport)) throw unsupported(`Unsupported transport '${transport}'`);

  const refs = payload.contextRefs === undefined ? [] : payload.contextRefs;
  if (!Array.isArray(refs) || refs.some((ref) => {
    if (typeof ref === 'string') return !text(ref);
    return !ref || typeof ref !== 'object' || Array.isArray(ref) || !text(ref.nodeId);
  })) {
    throw bad('contextRefs must be an array of node references');
  }

  const canonicalProjectRoot = path.resolve(text(payload.projectRoot) || path.resolve(projectRoot || process.cwd()));
  if (projectRoot && canonicalProjectRoot !== path.resolve(projectRoot)) {
    throw bad('projectRoot must match the backend project');
  }
  const dispatchInput = { ...payload };
  delete dispatchInput.workerCapability;
  delete dispatchInput.modelCapability;
  delete dispatchInput.supportedModels;
  delete dispatchInput.modelCapabilitySourceKind;
  delete dispatchInput.modelCapabilityVerificationLevel;
  const normalized = {
    ...dispatchInput,
    dispatchId,
    taskId,
    runtime,
    model,
    effort,
    transport,
    requestId,
    replyTo,
    projectRoot: canonicalProjectRoot,
    contextRefs: refs.map((ref) => typeof ref === 'string' ? ref : { ...ref }),
  };
  return {
    payload: normalized,
    key: dispatchCanonicalKey(normalized),
    fingerprint: dispatchFingerprint(payload, normalized),
    requested: { runtime, model, effort, transport },
    defaultRuntime,
  };
}

export function dispatchResponse(session, { replayed = false, requested = null, effective = null } = {}) {
  const routeRequested = requested || session?.requested || {
    runtime: session?.runtime || '',
    model: session?.model || '',
    effort: session?.effort || '',
    transport: session?.transport || (session?.uiMode === 'chat' ? 'chat' : 'pty'),
  };
  const routeEffective = effective || session?.effective || routeRequested;
  return {
    ok: true,
    dispatchId: session?.dispatchId || '',
    sessionId: session?.sessionId || '',
    graphNodeId: session?.graphNodeId || (session?.sessionId ? `session-${session.sessionId}` : ''),
    status: session?.status || 'starting',
    replayed: Boolean(replayed),
    requested: routeRequested,
    effective: routeEffective,
    ...(session?.attempt !== undefined ? { attempt: Number(session.attempt || 0) } : {}),
  };
}

function bad(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'BAD_DISPATCH';
  return error;
}

function unsupported(message) {
  const error = new Error(message);
  error.statusCode = 422;
  error.code = 'UNSUPPORTED';
  return error;
}
