const counterFields = [['uploadBytes', 'rawUploadBytes'], ['downloadBytes', 'rawDownloadBytes']];
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const bytePattern = /^(0|[1-9][0-9]*)$/;

function validateWindow(window) {
  if (!window || !Number.isSafeInteger(window.min) || !Number.isSafeInteger(window.max) || window.min > window.max) {
    throw new Error('Invalid V2Ray start-time window');
  }
}

function validateState(state) {
  if (state?.version !== 1 || typeof state.sampledAt !== 'string' || !Number.isFinite(Date.parse(state.sampledAt))
    || !Number.isInteger(state.uptimeSeconds) || state.uptimeSeconds < 0
    || !state.connections || typeof state.connections !== 'object' || Array.isArray(state.connections)) {
    throw new Error('Invalid persisted subscription traffic state');
  }
  validateWindow(state.bootWindow);
  for (const [id, counters] of Object.entries(state.connections)) {
    if (!uuidPattern.test(id) || !counters) throw new Error('Invalid persisted subscription traffic entry');
    for (const [field, rawField] of counterFields) {
      for (const value of [counters[field], counters[rawField]]) {
        if (typeof value !== 'string' || !bytePattern.test(value)) throw new Error('Invalid persisted traffic counter');
      }
    }
  }
}

export async function createTrafficUsage(database) {
  let state = await database.get('state');
  if (state !== undefined) validateState(state);

  function snapshot() {
    return {
      sampledAt: state?.sampledAt ?? null,
      uptimeSeconds: state?.uptimeSeconds ?? null,
      counters: new Map(Object.entries(state?.connections ?? {}).map(([id, counters]) => [
        id, Object.fromEntries(counterFields.map(([field]) => [field, counters[field]])),
      ])),
    };
  }

  async function save(next) {
    validateState(next);
    // Keep totals and raw-counter checkpoints in the same durable write.
    await database.put('state', next, { sync: true });
    state = next;
    return snapshot();
  }

  return {
    snapshot,
    async record(sample, counters, ids) {
      validateWindow(sample.bootWindow);
      const sameBoot = state && sample.uptimeSeconds >= state.uptimeSeconds
        && sample.bootWindow.min <= state.bootWindow.max && sample.bootWindow.max >= state.bootWindow.min;
      const connections = {};
      for (const id of ids) {
        const previous = state?.connections[id];
        const current = counters.get(id);
        const next = {};
        for (const [field, rawField] of counterFields) {
          const previousRaw = sameBoot ? BigInt(previous?.[rawField] ?? '0') : 0n;
          const raw = current?.[field] === undefined ? previousRaw : BigInt(current[field]);
          if (raw < 0n) throw new Error('V2Ray returned a negative traffic counter');
          const delta = raw >= previousRaw ? raw - previousRaw : raw;
          next[field] = (BigInt(previous?.[field] ?? '0') + delta).toString();
          next[rawField] = raw.toString();
        }
        connections[id] = next;
      }
      return save({
        version: 1, sampledAt: sample.sampledAt, uptimeSeconds: sample.uptimeSeconds,
        bootWindow: sameBoot ? {
          min: Math.max(state.bootWindow.min, sample.bootWindow.min),
          max: Math.min(state.bootWindow.max, sample.bootWindow.max),
        } : sample.bootWindow,
        connections,
      });
    },
    async remove(id) {
      if (!state || !Object.hasOwn(state.connections, id)) return;
      const connections = { ...state.connections };
      delete connections[id];
      await save({ ...state, connections });
    },
  };
}
