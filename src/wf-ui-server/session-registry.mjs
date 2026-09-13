import crypto from 'node:crypto';
import { RUNTIME_IDS } from './runtime-detector.mjs';

/**
 * Set of allowed agent runtimes for PTY sessions.
 * No fake agents in product code.
 */
export const ALLOWED_RUNTIMES = RUNTIME_IDS;
export const ALLOWED_AGENT_KINDS = new Set(['main', 'subagent']);

/**
 * Generate a short peer ID from a runtime name.
 * @param {string} runtime
 * @returns {string}
 */
function generatePeerId(runtime) {
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${runtime}-${suffix}`;
}

function resolveAgentKind(agentKind, role) {
  const explicit = String(agentKind || '').trim().toLowerCase();
  if (explicit) {
    if (!ALLOWED_AGENT_KINDS.has(explicit)) {
      throw new Error(`Invalid agent kind '${agentKind}'. Must be one of: ${[...ALLOWED_AGENT_KINDS].join(', ')}`);
    }
    return explicit;
  }
  const normalizedRole = String(role || '').toLowerCase();
  if (normalizedRole.includes('ceo') || normalizedRole.includes('main')) return 'main';
  return 'subagent';
}

/**
 * Generate a session ID (UUID v4).
 * @returns {string}
 */
export function generateSessionId() {
  return crypto.randomUUID();
}

/**
 * SessionRegistry manages PTY sessions for peer agents.
 *
 * Each session tracks: agent runtime, terminal dimensions, lifecycle status,
 * process info, and optional WebSocket attach state.
 */
export class SessionRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this._sessions = new Map();
    /** @type {Map<string, object>} */
    this._dispatches = new Map();
    /** @type {Map<string, Promise<void>>} */
    this._locks = new Map();
  }

  async withLock(sessionId, fn) {
    const key = String(sessionId || '__global__');
    const previous = this._locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const chain = previous.then(() => current, () => current);
    this._locks.set(key, chain);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this._locks.get(key) === chain) {
        this._locks.delete(key);
      }
    }
  }

  /**
   * Serialize an opt-in dispatch key.  Session locks remain keyed by session
   * id; dispatch locks close the race before a session id exists.
   */
  withDispatchLock(dispatchKey, fn) {
    return this.withLock(`dispatch:${String(dispatchKey || '')}`, fn);
  }

  getDispatch(dispatchKey) {
    return this._dispatches.get(String(dispatchKey || '')) || null;
  }

  setDispatch(dispatchKey, record) {
    const key = String(dispatchKey || '');
    if (!key) throw new Error('dispatchKey is required');
    const next = { ...(record || {}), key };
    this._dispatches.set(key, next);
    return next;
  }

  updateDispatch(dispatchKey, patch = {}) {
    const key = String(dispatchKey || '');
    const current = this._dispatches.get(key);
    if (!current) return null;
    const next = { ...current, ...patch, key };
    this._dispatches.set(key, next);
    return next;
  }

  /**
   * Create a new session.
   * @param {object} opts
   * @param {string} opts.taskId
   * @param {string} opts.runtime - Must be in ALLOWED_RUNTIMES
   * @param {number} [opts.cols=120]
   * @param {number} [opts.rows=32]
   * @param {string} [opts.projectRoot]
   * @returns {object} The created session object
   * @throws {Error} If runtime is not in ALLOWED_RUNTIMES
   */
  create({
    taskId = null,
    runtime,
    agentKind = '',
    role = 'terminal-agent',
    roleTitle = '',
    displayName = '',
    responsibility = '',
    roleProfileRef = null,
    objective = '',
    cols = 120,
    rows = 32,
    uiMode = 'pty',
    projectRoot = '',
    cwd = '',
    subagentMode = 'built-in-subagents',
    workflowMode = null,
    model = '',
    provider = '',
    prompt = '',
    env = null,
    permissions = null,
    customRole = '',
    skills = null,
    skillPolicy = 'auto',
    contextSources = null,
    capabilities = null,
    nodeConfig = null,
    restartRequired = false,
    restartRequiredFields = null,
    configRevision = 0,
    ceoPrompt = '',
    launchPolicy = null,
    graphContext = null,
    graphNodeId = '',
    graphVersion = 0,
    graphContextPath = '',
    parentAgentId = null,
    parentNodeId = null,
    parentSessionId = null,
    nodeHomePath = '',
    nodeHomeRel = '',
    nodeInitPath = '',
    nodeInitRel = '',
    dispatchId = null,
    dispatchKey = null,
    dispatchFingerprint = null,
    attempt = 0,
    dispatchRequestId = '',
    dispatchReplyTo = '',
    requested = null,
    effective = null,
    modelCapabilitySourceKind = null,
    modelCapabilityVerificationLevel = null,
    effort = '',
    transport = '',
    contextPackPath = '',
    contextRefs = null,
    initialPrompt = '',
  }) {
    if (!ALLOWED_RUNTIMES.has(runtime)) {
      throw new Error(`Invalid runtime '${runtime}'. Must be one of: ${[...ALLOWED_RUNTIMES].join(', ')}`);
    }
    const resolvedAgentKind = resolveAgentKind(agentKind, role);
    // Role identity (agent-team-cooperation-spec §3.2): roleTitle is the
    // session/profile role vocabulary; 'terminal-agent' remains only as the
    // legacy default for manually spawned PTYs with no role profile.
    const resolvedRoleTitle = String(roleTitle || '').trim()
      || (String(role || '').trim() && String(role).trim() !== 'terminal-agent' ? String(role).trim() : 'terminal-agent');
    const resolvedDisplayName = String(displayName || '').trim() || resolvedRoleTitle;
    // Backward compat: pre-rename callers send the legacy 'wf-subagents' id;
    // normalize it to the canonical 'wf-node-subagents' value before storing.
    const resolvedSubagentMode = subagentMode === 'wf-subagents' ? 'wf-node-subagents' : subagentMode;
    // Chat mode swaps the PTY transport for structured stdio drivers on the
    // same node semantics; unknown values fall back to the PTY default.
    const resolvedUiMode = String(uiMode || '').trim().toLowerCase() === 'chat' ? 'chat' : 'pty';

    const now = new Date().toISOString();
    const sessionId = generateSessionId();
    const peerId = generatePeerId(runtime);

    const session = {
      sessionId,
      taskId: taskId || null,
      peerId,
      runtime,
      agentKind: resolvedAgentKind,
      role,
      roleTitle: resolvedRoleTitle,
      displayName: resolvedDisplayName,
      responsibility: String(responsibility || '').trim(),
      roleProfileRef: roleProfileRef || null,
      objective,
      projectRoot,
      cwd: cwd || projectRoot || '',
      subagentMode: resolvedSubagentMode,
      workflowMode,
      model,
      provider,
      prompt,
      env: env && typeof env === 'object' && !Array.isArray(env) ? env : {},
      permissions: permissions && typeof permissions === 'object' && !Array.isArray(permissions) ? permissions : {},
      customRole,
      skills: Array.isArray(skills) ? skills : [],
      skillPolicy,
      contextSources: Array.isArray(contextSources) ? contextSources : ['workflow-map'],
      capabilities: Array.isArray(capabilities) ? capabilities : ['terminal'],
      nodeConfig: nodeConfig && typeof nodeConfig === 'object' && !Array.isArray(nodeConfig) ? nodeConfig : null,
      restartRequired: Boolean(restartRequired),
      restartRequiredFields: Array.isArray(restartRequiredFields) ? restartRequiredFields : [],
      configRevision: Number(configRevision || 0),
      ceoPrompt,
      launchPolicy,
      graphContext,
      graphNodeId,
      graphVersion,
      graphContextPath,
      parentAgentId,
      parentNodeId,
      parentSessionId,
      nodeHomePath,
      nodeHomeRel,
      nodeInitPath,
      nodeInitRel,
      status: 'starting',
      dispatchStatus: dispatchId ? 'starting' : null,
      cols,
      rows,
      uiMode: resolvedUiMode,
      providerSessionId: null,
      attachMode: false,
      startedAt: now,
      updatedAt: now,
      lastActivityAt: now,
      pid: null,
      exitCode: null,
      blockedReason: null,
      blockedHint: null,
      ptyProvider: null,
      agentSessionId: null,
      resumeCommand: null,
      terminalSeq: 0,
      transcriptRing: '',
      controlRequest: null,
      wsClientCount: 0,
      inputOwnerId: '',
      ptySessionId: sessionId,
      dispatchId: dispatchId || null,
      dispatchKey: dispatchKey || null,
      dispatchFingerprint: dispatchFingerprint || null,
      attempt: Number(attempt || 0),
      dispatchRequestId: String(dispatchRequestId || ''),
      dispatchReplyTo: String(dispatchReplyTo || ''),
      requested: requested && typeof requested === 'object' ? requested : null,
      effective: effective && typeof effective === 'object' ? effective : null,
      modelCapabilitySourceKind: String(modelCapabilitySourceKind || '') || null,
      modelCapabilityVerificationLevel: String(modelCapabilityVerificationLevel || '') || null,
      effort: String(effort || ''),
      transport: String(transport || (resolvedUiMode === 'chat' ? 'chat' : 'pty')),
      contextPackPath: String(contextPackPath || ''),
      contextRefs: Array.isArray(contextRefs) ? contextRefs : [],
      initialPrompt: String(initialPrompt || ''),
    };

    this._sessions.set(sessionId, session);
    return session;
  }

  /**
   * Get a session by ID.
   * @param {string} sessionId
   * @returns {object|undefined}
   */
  get(sessionId) {
    return this._sessions.get(sessionId);
  }

  /**
   * Get all sessions as an array.
   * @returns {object[]}
   */
  getAll() {
    return [...this._sessions.values()];
  }

  /**
   * Get all sessions for a given task ID.
   * @param {string} taskId
   * @returns {object[]}
   */
  getAllForTask(taskId) {
    return [...this._sessions.values()].filter(s => s.taskId === taskId);
  }

  /**
   * Update session fields. Merges the patch into the session and sets updatedAt.
   * @param {string} sessionId
   * @param {object} patch - Fields to merge (status, cols, rows, pid, exitCode, attachMode, wsClientCount, transcriptRing)
   */
  update(sessionId, patch) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined && key in session) {
        session[key] = value;
      }
    }
    session.updatedAt = new Date().toISOString();
    if (session.dispatchKey && this._dispatches.has(session.dispatchKey)) {
      const record = this._dispatches.get(session.dispatchKey);
      this._dispatches.set(session.dispatchKey, {
        ...record,
        sessionId: session.sessionId,
        attempt: Number(session.attempt || record.attempt || 0),
        status: session.dispatchStatus || session.status,
      });
    }
  }

  /**
   * Remove a session from the registry.
   * @param {string} sessionId
   */
  remove(sessionId) {
    this._sessions.delete(sessionId);
  }

  /**
   * Stop and remove a web-owned session. Persisted recovery metadata lives on disk.
   * @param {string} sessionId
   * @returns {object|null} The removed session when found
   */
  stop(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return null;
    this._sessions.delete(sessionId);
    const stoppedStatus = session.dispatchId ? 'cancelled' : 'stopped';
    if (session.dispatchKey && this._dispatches.has(session.dispatchKey)) {
      const record = this._dispatches.get(session.dispatchKey);
      this._dispatches.set(session.dispatchKey, {
        ...record,
        sessionId,
        attempt: Number(session.attempt || record.attempt || 0),
        status: stoppedStatus,
      });
    }
    return {
      ...session,
      status: stoppedStatus,
      dispatchStatus: session.dispatchId ? 'cancelled' : session.dispatchStatus,
      stoppedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Number of active sessions.
   * @returns {number}
   */
  count() {
    return this._sessions.size;
  }
}
