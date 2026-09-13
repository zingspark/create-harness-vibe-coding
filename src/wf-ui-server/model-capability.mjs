import { spawn, spawnSync } from 'node:child_process';
import { getRuntimeDefinition, resolveExecutable } from './runtime-detector.mjs';
import { readRuntimeConfig } from './runtime-config.mjs';
import { loadSettings } from './settings.mjs';

// Model selection is a dispatch preflight, not a best-effort launch hint.  A
// probe may only return supported when it has a trusted source for the exact
// model (and, when requested, the exact effort).  In particular, this module
// never turns a model string from the HTTP envelope into a catalog entry.
export const MODEL_CAPABILITY_CODES = Object.freeze({
  UNSUPPORTED: 'UNSUPPORTED',
  UNAVAILABLE: 'UNAVAILABLE',
  UNVERIFIED: 'UNVERIFIED',
});

const PROBE_TIMEOUT_MS = 5000;
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;
const MAX_CODEX_PAGES = 32;

function text(value) {
  return String(value ?? '').trim();
}

function safeReason(reason, fallbackCode, fallbackMessage) {
  if (!reason || typeof reason !== 'object') {
    return { code: fallbackCode, message: fallbackMessage };
  }
  const code = text(reason.code).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 100) || fallbackCode;
  const message = text(reason.message).replace(/[\r\n]/g, ' ').slice(0, 240) || fallbackMessage;
  return { code, message };
}

function modelError(code, message, details = {}) {
  const error = new Error(message);
  error.statusCode = 422;
  error.code = code;
  error.details = {
    sourceKind: text(details.sourceKind) || 'none',
    verificationLevel: text(details.verificationLevel) || code.toLowerCase(),
    ...(details.reason ? { reason: safeReason(details.reason, `MODEL_${code}`, message) } : {}),
  };
  return error;
}

function unsupported(message, details = {}) {
  return modelError(MODEL_CAPABILITY_CODES.UNSUPPORTED, message, details);
}

function unavailable(message, details = {}) {
  return modelError(MODEL_CAPABILITY_CODES.UNAVAILABLE, message, details);
}

function unverified(message, details = {}) {
  return modelError(MODEL_CAPABILITY_CODES.UNVERIFIED, message, details);
}

function cleanSupportedEfforts(value) {
  if (!Array.isArray(value)) return undefined;
  const efforts = value.map(item => {
    if (typeof item === 'string' || typeof item === 'number') return text(item).toLowerCase();
    if (!item || typeof item !== 'object') return '';
    return text(item.reasoningEffort || item.effort || item.id || item.name).toLowerCase();
  }).filter(Boolean);
  return [...new Set(efforts)];
}

function effortFromVariantMetadata(value) {
  if (typeof value === 'string' || typeof value === 'number') return text(value).toLowerCase();
  if (!value || typeof value !== 'object') return '';
  return text(value.effort || value.reasoningEffort || value.reasoning_effort).toLowerCase();
}

function parseJsonBlock(lines, start) {
  let candidate = '';
  let depth = 0;
  let sawOpening = false;
  let inString = false;
  let escaped = false;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    candidate += `${candidate ? '\n' : ''}${line}`;
    for (const character of line) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (character === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (character === '{') {
        sawOpening = true;
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
      }
    }
    if (!sawOpening || depth !== 0) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return { value, end: index };
    } catch {
      // A balanced but invalid block is retained as a name-only row and must
      // not consume the next model's metadata.
    }
    return { value: null, end: index };
  }
  return null;
}

function normalizeOpenCodeEntry(header, metadata = null) {
  const catalogId = text(header);
  const providerId = text(metadata?.providerID || metadata?.providerId);
  const modelId = text(metadata?.id || metadata?.model || (catalogId.includes('/') ? catalogId.slice(catalogId.lastIndexOf('/') + 1) : catalogId));
  const variantsValue = metadata && Object.hasOwn(metadata, 'variants') && metadata.variants && typeof metadata.variants === 'object'
    ? metadata.variants
    : undefined;
  const variantMap = {};
  const ambiguousEfforts = new Set();
  if (variantsValue) {
    for (const [variantId, variantMetadata] of Object.entries(variantsValue)) {
      const effort = effortFromVariantMetadata(variantMetadata);
      if (!effort || ambiguousEfforts.has(effort)) continue;
      if (!Object.hasOwn(variantMap, effort)) variantMap[effort] = text(variantId);
      // If two provider variants claim the same effort, remove the mapping;
      // selecting one by object order would silently choose an unverified
      // provider-specific variant.
      else if (variantMap[effort] !== text(variantId)) {
        delete variantMap[effort];
        ambiguousEfforts.add(effort);
      }
    }
  }
  const supportedEfforts = variantsValue
    ? [...new Set(Object.keys(variantMap))]
    : undefined;
  return {
    catalogId,
    providerId,
    modelId,
    ...(variantsValue ? { variants: Object.keys(variantsValue) } : {}),
    ...(supportedEfforts ? { supportedEfforts } : {}),
    ...(Object.keys(variantMap).length ? { effortVariants: variantMap } : {}),
  };
}

/**
 * Parse the first-party `opencode models --verbose` output. Each model is
 * printed as a qualified id followed by its JSON metadata. A name-only row is
 * retained, but deliberately has no effort metadata.
 */
export function parseOpenCodeVerboseCatalog(output) {
  const lines = String(output || '').split(/\r?\n/);
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = text(lines[index]);
    if (!header || header.startsWith('{') || header.startsWith('[')) continue;
    const next = index + 1;
    if (next < lines.length && text(lines[next]).startsWith('{')) {
      const parsed = parseJsonBlock(lines, next);
      if (parsed?.value) {
        entries.push(normalizeOpenCodeEntry(header, parsed.value));
        index = parsed.end;
        continue;
      }
    }
    // `--pure` without verbose metadata is a complete model-name catalog, not
    // an effort catalog. Keep it discoverable so requested effort remains
    // explicitly UNVERIFIED instead of being guessed from the model name.
    entries.push(normalizeOpenCodeEntry(header));
  }
  return entries;
}

function openCodeEntryMatches(entry, requestedModel) {
  const requested = text(requestedModel);
  if (!requested) return false;
  const catalogId = text(entry?.catalogId);
  const modelId = text(entry?.modelId);
  const qualified = entry?.providerId && modelId ? `${entry.providerId}/${modelId}` : '';
  if (catalogId === requested || qualified === requested || modelId === requested) return true;
  return !requested.includes('/') && catalogId.endsWith(`/${requested}`);
}

/**
 * Resolve one OpenCode model and its own exact variant mapping. Variant data
 * never comes from a neighboring model entry or from the requested string.
 */
export function resolveOpenCodeModelCapability(catalog, requestedModel, effort = '') {
  const model = text(requestedModel);
  const entries = Array.isArray(catalog)
    ? catalog.filter(candidate => openCodeEntryMatches(candidate, model))
    : [];
  // OpenCode's launch contract is provider/model. A bare model id is unsafe
  // even when today's catalog happens to contain only one provider: a later
  // provider addition would silently change the runtime selected by an old
  // dispatch request. Keep the rejection tied to the complete native catalog
  // so callers receive an explicit, actionable 422 rather than a guess.
  if (!model.includes('/')) {
    return {
      status: 'unsupported',
      sourceKind: 'opencode-models',
      verificationLevel: 'authoritative',
      complete: true,
      model,
      reason: {
        code: 'MODEL_PROVIDER_REQUIRED',
        message: 'OpenCode dispatch requires an exact provider/model id; specify the provider explicitly.',
      },
    };
  }
  if (entries.length > 1) {
    return {
      status: 'unsupported',
      sourceKind: 'opencode-models',
      verificationLevel: 'authoritative',
      complete: true,
      model,
      reason: {
        code: 'MODEL_CATALOG_AMBIGUOUS',
        message: 'The OpenCode catalog contains multiple entries for this provider/model id; choose one exact catalog id.',
      },
    };
  }
  const entry = entries[0];
  if (!entry) {
    return {
      status: 'unsupported',
      sourceKind: 'opencode-models',
      verificationLevel: 'authoritative',
      complete: true,
      model,
      reason: { code: 'MODEL_NOT_IN_AUTHORITATIVE_CATALOG', message: 'The model is absent from the complete OpenCode models catalog.' },
    };
  }
  const result = supportedFromEntry(model, 'opencode-models', 'authoritative', entry, entry.supportedEfforts);
  const requestedEffort = text(effort).toLowerCase();
  if (!requestedEffort) return result;
  if (!entry.supportedEfforts) return result;
  if (!entry.supportedEfforts.includes(requestedEffort)) {
    return {
      status: 'unsupported',
      sourceKind: 'opencode-models',
      verificationLevel: 'authoritative',
      complete: true,
      model,
      reason: { code: 'MODEL_EFFORT_NOT_SUPPORTED', message: `The authoritative OpenCode model metadata excludes effort '${requestedEffort}'.` },
    };
  }
  const effortVariant = entry.effortVariants?.[requestedEffort];
  if (!effortVariant) {
    return {
      status: 'unverified',
      sourceKind: 'opencode-models',
      verificationLevel: 'authoritative',
      complete: true,
      model,
      reason: { code: 'MODEL_EFFORT_VARIANT_UNVERIFIED', message: 'The model metadata names the effort but does not identify one exact launch variant.' },
    };
  }
  return { ...result, effortVariant, catalogModelId: entry.catalogId };
}

/** Read only the Harness-owned operator model declarations from project settings. */
export function readHarnessRuntimeCapabilities(projectRoot, runtime) {
  const configured = loadSettings(projectRoot)?.runtimeCapabilities;
  const runtimeConfig = configured && typeof configured === 'object'
    ? (configured[runtime] || (runtime === 'cc' ? configured.claude : null))
    : null;
  const models = runtimeConfig?.models && typeof runtimeConfig.models === 'object' && !Array.isArray(runtimeConfig.models)
    ? runtimeConfig.models
    : {};
  const normalized = {};
  for (const [model, value] of Object.entries(models)) {
    const exactModel = text(model);
    if (!exactModel || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const supportedEfforts = cleanSupportedEfforts(value.supportedEfforts);
    normalized[exactModel] = {
      ...(supportedEfforts ? { supportedEfforts } : {}),
    };
  }
  return {
    sourceKind: 'harness-operator-runtime-capabilities',
    verificationLevel: 'operator-configured',
    models: normalized,
  };
}

/**
 * Validate a probe result against the canonical dispatch request.  This is
 * deliberately exported as a pure helper so construction seams can exercise
 * it without starting a runtime or making a provider request.
 */
export function assertModelCapability(result, { runtime, model, effort } = {}) {
  const requestedModel = text(model);
  const requestedEffort = text(effort).toLowerCase();
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw unverified('Model capability could not be verified: probe returned no result', {
      reason: { code: 'MODEL_CAPABILITY_UNVERIFIED', message: 'No trusted model capability result was returned.' },
    });
  }

  const status = text(result.status).toLowerCase();
  const sourceKind = text(result.sourceKind);
  const verificationLevel = text(result.verificationLevel).toLowerCase();
  const reason = result.reason;
  if (text(runtime).toLowerCase() === 'opencode' && !requestedModel.includes('/')) {
    // OpenCode's CLI requires provider/model. Enforce that launch identity at
    // the server seam too: a trusted construction probe may be backed by a
    // catalog with two providers, but it must not authorize a bare id that
    // the CLI would resolve implicitly or differently over time.
    throw unsupported('OpenCode dispatch requires an exact provider/model id; specify the provider explicitly.', {
      sourceKind,
      verificationLevel,
      reason: {
        code: 'MODEL_PROVIDER_REQUIRED',
        message: 'The OpenCode model must include its provider (provider/model).',
      },
    });
  }

  if (status === 'unavailable') {
    throw unavailable('Model capability probe is unavailable', { sourceKind, verificationLevel, reason });
  }
  if (status === 'unverified' || status === '') {
    throw unverified('Model capability is not backed by a trusted catalog', { sourceKind, verificationLevel, reason });
  }
  if (status === 'unsupported') {
    // An unsupported answer is meaningful only from a complete authoritative
    // list.  Partial, inferred, or operator-unknown answers are unverified.
    if (result.complete !== true
      || !['authoritative', 'operator-configured'].includes(verificationLevel)
      || !sourceKind) {
      throw unverified('Model capability cannot establish that the model is unsupported', {
        sourceKind,
        verificationLevel,
        reason: reason || { code: 'MODEL_CAPABILITY_UNVERIFIED', message: 'The source is not a complete authoritative catalog.' },
      });
    }
    throw unsupported(`Unsupported model '${requestedModel}'`, { sourceKind, verificationLevel, reason });
  }
  if (status !== 'supported') {
    throw unverified('Model capability returned an unknown status', {
      sourceKind,
      verificationLevel,
      reason: { code: 'MODEL_CAPABILITY_UNVERIFIED', message: 'The probe status was not recognized.' },
    });
  }

  if (!sourceKind || !verificationLevel || result.complete !== true) {
    throw unverified('Model capability is not complete and trusted', {
      sourceKind,
      verificationLevel,
      reason: reason || { code: 'MODEL_CAPABILITY_UNVERIFIED', message: 'The supported result is missing trusted provenance.' },
    });
  }
  const returnedModel = text(result.model);
  if (!returnedModel || returnedModel !== requestedModel) {
    throw unsupported(`Model capability did not verify requested model '${requestedModel}'`, {
      sourceKind,
      verificationLevel,
      reason: { code: 'MODEL_CAPABILITY_MODEL_MISMATCH', message: 'The provider result did not identify the requested model exactly.' },
    });
  }

  const supportedEfforts = cleanSupportedEfforts(result.supportedEfforts);
  if (requestedEffort) {
    // Do not infer an effort from a model being present.  If the provider
    // omitted effort metadata we cannot claim xhigh (or any other effort).
    if (!supportedEfforts) {
      throw unverified('Model effort capability is not verified', {
        sourceKind,
        verificationLevel,
        reason: { code: 'MODEL_EFFORT_METADATA_UNAVAILABLE', message: 'The trusted model source did not publish supported efforts.' },
      });
    }
    if (!supportedEfforts.includes(requestedEffort)) {
      throw unsupported(`Unsupported effort '${requestedEffort}' for model '${requestedModel}'`, {
        sourceKind,
        verificationLevel,
        reason: { code: 'MODEL_EFFORT_NOT_SUPPORTED', message: 'The authoritative model source excludes the requested effort.' },
      });
    }
  }

  return {
    status: 'supported',
    sourceKind,
    verificationLevel,
    complete: true,
    model: returnedModel,
    ...(supportedEfforts ? { supportedEfforts } : {}),
    ...(result.effortVariant ? { effortVariant: text(result.effortVariant) } : {}),
    ...(result.catalogModelId ? { catalogModelId: text(result.catalogModelId) } : {}),
  };
}

function probeDeadline(deadlineAt) {
  const supplied = Number(deadlineAt);
  if (Number.isFinite(supplied)) return supplied;
  return Date.now() + PROBE_TIMEOUT_MS;
}

function spawnOptions(projectRoot, deadlineAt) {
  return {
    cwd: projectRoot,
    windowsHide: true,
    shell: process.platform === 'win32',
    env: process.env,
    deadlineAt,
  };
}

function killOwnedProcess(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
      // `where.exe` commonly resolves .CMD launchers on Windows.  The shell
      // wrapper and its launcher are both owned by this probe, so terminate
      // exactly that process tree on timeout/response completion.
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 1000,
        stdio: 'ignore',
      });
    } else {
      child.kill('SIGTERM');
    }
  } catch { /* the child may have exited */ }
}

function runCapture(command, args, { projectRoot, deadlineAt }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, spawnOptions(projectRoot, deadlineAt));
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killOwnedProcess(child);
      fn(value);
    };
    const remaining = Math.max(1, deadlineAt - Date.now());
    const timer = setTimeout(() => finish(reject, unavailable('Model capability probe deadline elapsed', {
      reason: { code: 'MODEL_CAPABILITY_TIMEOUT', message: 'The native model catalog probe exceeded its deadline.' },
    })), remaining);
    timer.unref?.();
    child.stdout?.on('data', chunk => {
      if (stdout.length < MAX_PROBE_OUTPUT_BYTES) stdout += String(chunk).slice(0, MAX_PROBE_OUTPUT_BYTES - stdout.length);
    });
    child.stderr?.on('data', chunk => {
      if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length);
    });
    child.once('error', () => finish(reject, unavailable('Native model catalog probe could not start', {
      reason: { code: 'MODEL_CAPABILITY_PROCESS_ERROR', message: 'The runtime model catalog process could not be started.' },
    })));
    child.once('close', code => {
      if (code !== 0) {
        finish(reject, unavailable('Native model catalog probe failed', {
          reason: { code: 'MODEL_CAPABILITY_PROCESS_ERROR', message: 'The runtime model catalog process exited unsuccessfully.' },
        }));
        return;
      }
      finish(resolve, { stdout, stderr });
    });
  });
}

function codexModelsFromResult(result) {
  const data = result?.data ?? result?.models ?? result?.items ?? result;
  return Array.isArray(data) ? data : [];
}

function codexModelId(entry) {
  if (typeof entry === 'string') return text(entry);
  if (!entry || typeof entry !== 'object') return '';
  return text(entry.id || entry.model || entry.name);
}

function codexEfforts(entry) {
  if (!entry || typeof entry !== 'object') return undefined;
  return cleanSupportedEfforts(
    entry.supportedReasoningEfforts
      || entry.supportedEfforts
      || entry.reasoningEfforts
      || entry.reasoning_efforts,
  );
}

function runCodexModelList(command, { projectRoot, deadlineAt }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['app-server', '--listen', 'stdio://'], spawnOptions(projectRoot, deadlineAt));
    let buffer = '';
    let settled = false;
    let nextId = 1;
    let modelListId = null;
    let pages = 0;
    let entries = [];
    let complete = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killOwnedProcess(child);
      fn(value);
    };
    const remaining = Math.max(1, deadlineAt - Date.now());
    const timer = setTimeout(() => finish(reject, unavailable('Codex model catalog probe deadline elapsed', {
      sourceKind: 'codex-app-server-model-list',
      verificationLevel: 'unavailable',
      reason: { code: 'MODEL_CAPABILITY_TIMEOUT', message: 'The Codex model/list probe exceeded its deadline.' },
    })), remaining);
    timer.unref?.();

    const write = message => {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); } catch {
        finish(reject, unavailable('Codex model catalog probe could not write request', {
          sourceKind: 'codex-app-server-model-list',
          reason: { code: 'MODEL_CAPABILITY_PROCESS_ERROR', message: 'The Codex model catalog process did not accept the request.' },
        }));
      }
    };
    const requestModels = cursor => {
      modelListId = nextId++;
      write({ id: modelListId, method: 'model/list', params: { includeHidden: true, ...(cursor ? { cursor } : {}) } });
    };
    const onMessage = message => {
      if (!message || typeof message !== 'object') return;
      if (message.id === 1) {
        if (message.error) {
          finish(reject, unavailable('Codex model catalog initialization failed', {
            sourceKind: 'codex-app-server-model-list',
            reason: { code: 'MODEL_CAPABILITY_PROVIDER_ERROR', message: 'Codex did not initialize its model catalog.' },
          }));
          return;
        }
        write({ method: 'initialized' });
        requestModels('');
        return;
      }
      if (message.id !== modelListId) return;
      if (message.error) {
        finish(reject, unavailable('Codex model catalog request failed', {
          sourceKind: 'codex-app-server-model-list',
          reason: { code: 'MODEL_CAPABILITY_PROVIDER_ERROR', message: 'Codex did not return its model catalog.' },
        }));
        return;
      }
      const result = message.result || {};
      entries = entries.concat(codexModelsFromResult(result));
      pages += 1;
      const cursor = text(result.nextCursor || result.next_cursor || '');
      if (cursor && pages < MAX_CODEX_PAGES) {
        requestModels(cursor);
        return;
      }
      if (cursor) {
        finish(reject, unavailable('Codex model catalog was not fully enumerated', {
          sourceKind: 'codex-app-server-model-list',
          reason: { code: 'MODEL_CAPABILITY_PARTIAL_CATALOG', message: 'The Codex model catalog pagination limit was reached.' },
        }));
        return;
      }
      complete = true;
      finish(resolve, { entries, complete });
    };

    child.stdout?.on('data', chunk => {
      buffer += String(chunk);
      if (buffer.length > MAX_PROBE_OUTPUT_BYTES) {
        finish(reject, unavailable('Codex model catalog output exceeded the probe limit', {
          sourceKind: 'codex-app-server-model-list',
          reason: { code: 'MODEL_CAPABILITY_OUTPUT_LIMIT', message: 'The Codex model catalog response was too large.' },
        }));
        return;
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        try { onMessage(JSON.parse(line)); } catch { /* non-protocol diagnostics are ignored */ }
      }
    });
    child.once('error', () => finish(reject, unavailable('Codex model catalog process could not start', {
      sourceKind: 'codex-app-server-model-list',
      reason: { code: 'MODEL_CAPABILITY_PROCESS_ERROR', message: 'The Codex model catalog process could not be started.' },
    })));
    child.once('close', code => {
      if (!settled) finish(reject, unavailable('Codex model catalog process exited before returning a model catalog', {
        sourceKind: 'codex-app-server-model-list',
        reason: { code: code === 0 ? 'MODEL_CAPABILITY_EMPTY_RESULT' : 'MODEL_CAPABILITY_PROCESS_ERROR', message: 'Codex did not return a complete model catalog.' },
      }));
    });

    write({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'harness-model-capability-probe', title: 'Harness model capability probe', version: '0.0.0' },
        capabilities: {},
      },
    });
  });
}

function operatorConfiguredModels(projectRoot, runtime) {
  let config;
  try { config = readRuntimeConfig(projectRoot, runtime); } catch { return []; }
  const models = [];
  for (const file of config.files || []) {
    const value = file.values?.availableModels;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && text(item)) models.push(text(item));
        else if (item && typeof item === 'object' && text(item.id || item.model || item.name)) models.push(text(item.id || item.model || item.name));
      }
    }
  }
  return [...new Set(models)];
}

function operatorCapabilityResult(projectRoot, runtime, requestedModel, effort) {
  const declarations = readHarnessRuntimeCapabilities(projectRoot, runtime);
  const declared = declarations.models[requestedModel];
  if (!declared) return null;
  // The compact operator schema declares model + effort names only. OpenCode
  // additionally needs an exact provider variant id, which this declaration
  // intentionally does not invent; native verbose metadata remains the only
  // source that can authorize an OpenCode effort launch.
  if (runtime === 'opencode' && text(effort)) {
    return {
      status: 'unverified',
      sourceKind: declarations.sourceKind,
      verificationLevel: declarations.verificationLevel,
      complete: true,
      model: requestedModel,
      reason: { code: 'MODEL_EFFORT_VARIANT_UNVERIFIED', message: 'An operator effort declaration cannot identify an exact OpenCode variant.' },
    };
  }
  return supportedFromEntry(
    requestedModel,
    declarations.sourceKind,
    declarations.verificationLevel,
    declared,
    declared.supportedEfforts,
  );
}

function supportedFromEntry(model, sourceKind, verificationLevel, entry, supportedEfforts) {
  return {
    status: 'supported',
    sourceKind,
    verificationLevel,
    complete: true,
    model,
    ...(supportedEfforts ? { supportedEfforts } : {}),
    ...(entry && typeof entry === 'object' && entry.supportedEfforts ? { supportedEfforts: cleanSupportedEfforts(entry.supportedEfforts) } : {}),
  };
}

/**
 * Native-first model capability probe. It performs only catalog discovery:
 * Codex app-server initialize/model-list and OpenCode models. No prompt,
 * thread, turn, or inference request is sent.
 */
export async function probeModelCapability({ runtime, model, effort = '', projectRoot, deadlineAt } = {}) {
  const runtimeId = text(runtime);
  const requestedModel = text(model);
  const deadline = probeDeadline(deadlineAt);
  if (!runtimeId || !requestedModel) {
    return {
      status: 'unverified', sourceKind: 'none', verificationLevel: 'unverified', complete: false, model: requestedModel,
      reason: { code: 'MODEL_CAPABILITY_UNVERIFIED', message: 'Runtime and model are required for capability discovery.' },
    };
  }

  if (runtimeId === 'claude' || runtimeId === 'cc') {
    const operatorResult = operatorCapabilityResult(projectRoot, runtimeId, requestedModel, effort);
    if (operatorResult) return operatorResult;
    const operatorDeclarations = readHarnessRuntimeCapabilities(projectRoot, runtimeId);
    if (Object.keys(operatorDeclarations.models).length) {
      return {
        status: 'unsupported',
        sourceKind: operatorDeclarations.sourceKind,
        verificationLevel: operatorDeclarations.verificationLevel,
        complete: true,
        model: requestedModel,
        reason: { code: 'MODEL_NOT_IN_OPERATOR_ALLOWLIST', message: 'The model is absent from the Harness operator model declaration.' },
      };
    }
    const configured = operatorConfiguredModels(projectRoot, runtimeId);
    if (!configured.length) {
      return {
        status: 'unverified', sourceKind: 'none', verificationLevel: 'unverified', complete: false, model: requestedModel,
        reason: { code: 'MODEL_CAPABILITY_UNVERIFIED', message: 'Claude has no trusted operator model allowlist configured.' },
      };
    }
    return configured.includes(requestedModel)
      ? supportedFromEntry(requestedModel, 'claude-operator-config', 'operator-configured')
      : {
        status: 'unsupported', sourceKind: 'claude-operator-config', verificationLevel: 'operator-configured', complete: true, model: requestedModel,
        reason: { code: 'MODEL_NOT_IN_OPERATOR_ALLOWLIST', message: 'The model is absent from the operator model allowlist.' },
      };
  }

  const definition = getRuntimeDefinition(runtimeId);
  const commandName = definition?.commands?.[0];
  const executable = commandName ? resolveExecutable(commandName) : null;
  if (!executable) {
    return {
      status: 'unavailable', sourceKind: `${runtimeId || 'runtime'}-model-catalog`, verificationLevel: 'unavailable', complete: false, model: requestedModel,
      reason: { code: 'MODEL_CAPABILITY_UNAVAILABLE', message: 'The runtime executable is not available for model discovery.' },
    };
  }

  if (runtimeId === 'codex') {
    try {
      const catalog = await runCodexModelList(executable, { projectRoot, deadlineAt: deadline });
      const entry = catalog.entries.find(candidate => codexModelId(candidate) === requestedModel);
      if (entry) return supportedFromEntry(requestedModel, 'codex-app-server-model-list', 'authoritative', entry, codexEfforts(entry));
      const operatorResult = operatorCapabilityResult(projectRoot, runtimeId, requestedModel, effort);
      if (operatorResult) return operatorResult;
      return {
        status: 'unsupported', sourceKind: 'codex-app-server-model-list', verificationLevel: 'authoritative', complete: catalog.complete, model: requestedModel,
        reason: { code: 'MODEL_NOT_IN_AUTHORITATIVE_CATALOG', message: 'The model is absent from the complete Codex model/list catalog.' },
      };
    } catch (error) {
      if (error?.code === MODEL_CAPABILITY_CODES.UNAVAILABLE) throw error;
      const operatorResult = operatorCapabilityResult(projectRoot, runtimeId, requestedModel, effort);
      if (operatorResult) return operatorResult;
      return {
        status: 'unavailable', sourceKind: 'codex-app-server-model-list', verificationLevel: 'unavailable', complete: false, model: requestedModel,
        reason: { code: 'MODEL_CAPABILITY_UNAVAILABLE', message: 'Codex model discovery did not complete.' },
      };
    }
  }

  if (runtimeId === 'opencode') {
    try {
      const result = await runCapture(executable, ['models', '--pure', '--log-level', 'ERROR', '--verbose'], { projectRoot, deadlineAt: deadline });
      const capability = resolveOpenCodeModelCapability(parseOpenCodeVerboseCatalog(result.stdout), requestedModel, effort);
      if (capability.status === 'supported' || capability.status === 'unverified') return capability;
      if (capability.reason?.code === 'MODEL_NOT_IN_AUTHORITATIVE_CATALOG') {
        const operatorResult = operatorCapabilityResult(projectRoot, runtimeId, requestedModel, effort);
        if (operatorResult) return operatorResult;
      }
      return capability;
    } catch (error) {
      if (error?.code === MODEL_CAPABILITY_CODES.UNAVAILABLE) throw error;
      const operatorResult = operatorCapabilityResult(projectRoot, runtimeId, requestedModel, effort);
      if (operatorResult) return operatorResult;
      return {
        status: 'unavailable', sourceKind: 'opencode-models', verificationLevel: 'unavailable', complete: false, model: requestedModel,
        reason: { code: 'MODEL_CAPABILITY_UNAVAILABLE', message: 'OpenCode model discovery did not complete.' },
      };
    }
  }

  return {
    status: 'unverified', sourceKind: 'none', verificationLevel: 'unverified', complete: false, model: requestedModel,
    reason: { code: 'MODEL_CAPABILITY_UNVERIFIED', message: 'This runtime has no trusted native model catalog integration.' },
  };
}

export function capabilityErrorFromProbe(result, request) {
  return assertModelCapability(result, request);
}
