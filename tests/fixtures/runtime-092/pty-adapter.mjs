// Deterministic PTY fixture for dispatch lifecycle contract tests.
// It deliberately does not complete a task: a PTY exit is not delivery proof.
const calls = [];

export const recorder = {
  calls,
  reset() {
    calls.length = 0;
  },
  count() {
    return calls.length;
  },
};

export async function spawnPty(options) {
  const record = {
    options,
    writes: [],
    onData: typeof options.onData === 'function' ? options.onData : null,
    onExit: typeof options.onExit === 'function' ? options.onExit : null,
  };
  calls.push(record);

  const ptyProcess = {
    pid: 59000 + calls.length,
    write(data) {
      record.writes.push(String(data));
    },
    kill() {},
    onData(callback) {
      record.onData = callback;
    },
    onExit(callback) {
      record.onExit = callback;
    },
  };

  return {
    sessionId: options.sessionId,
    pid: ptyProcess.pid,
    ptyProcess,
    ptyProvider: 'runtime-092-fixture',
  };
}

export function emitData(sessionId, data) {
  const record = calls.find(item => item.options.sessionId === sessionId);
  if (!record?.onData) return false;
  record.onData(data);
  return true;
}

export function emitExit(sessionId, exitCode = 0) {
  const record = calls.find(item => item.options.sessionId === sessionId);
  if (!record?.onExit) return false;
  record.onExit({ exitCode });
  return true;
}
