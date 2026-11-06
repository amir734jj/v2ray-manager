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
  const Checkpoint = database.define('TrafficCheckpoint', {
    id: { type: DataTypes.STRING(16), primaryKey: true },
    value: { type: DataTypes.JSON, allowNull: false },
  }, { tableName: 'gateway_traffic_checkpoints', timestamps: false });
  await Checkpoint.sync();

  async function readState(transaction) {
    const row = await Checkpoint.findByPk('state', { transaction });
    const saved = row?.value;
    if (saved !== undefined) validateState(saved);
    return saved;
  }

  let state = await readState();

  function snapshot() {
    return {
      sampledAt: state?.sampledAt ?? null,
      uptimeSeconds: state?.uptimeSeconds ?? null,
      counters: new Map(Object.entries(state?.connections ?? {}).map(([id, counters]) => [
        id, Object.fromEntries(counterFields.map(([field]) => [field, counters[field]])),
      ])),
    };
  }

  async function update(transform) {
    const next = await database.transaction({ type: Transaction.TYPES.IMMEDIATE }, async transaction => {
      const current = await readState(transaction);
      const updated = transform(current);
      if (updated === undefined) return current;
      validateState(updated);
      await Checkpoint.upsert({ id: 'state', value: updated }, { transaction });
      return updated;
    });
    state = next;
    return snapshot();
  }

  return {
    snapshot,
    async record(sample, counters, ids, resetId) {
      validateWindow(sample.bootWindow);
      if (resetId !== undefined && !ids.includes(resetId)) {
        throw new Error('Cannot reset traffic for an unknown subscription');
      }
      return update(currentState => {
        if (currentState && Date.parse(sample.sampledAt) < Date.parse(currentState.sampledAt)) {
          throw new Error('Out-of-order V2Ray traffic sample; retry collection');
        }
        const sameBoot = currentState && sample.uptimeSeconds >= currentState.uptimeSeconds
          && sample.bootWindow.min <= currentState.bootWindow.max && sample.bootWindow.max >= currentState.bootWindow.min;
        const connections = {};
        for (const id of ids) {
          const previous = currentState?.connections[id];
          const current = counters.get(id);
          const next = {};
          for (const [field, rawField] of counterFields) {
            const previousRaw = sameBoot ? BigInt(previous?.[rawField] ?? '0') : 0n;
            const raw = current?.[field] === undefined ? previousRaw : BigInt(current[field]);
            if (raw < 0n) throw new Error('V2Ray returned a negative traffic counter');
            const delta = raw >= previousRaw ? raw - previousRaw : raw;
            next[field] = id === resetId ? '0' : (BigInt(previous?.[field] ?? '0') + delta).toString();
            next[rawField] = raw.toString();
          }
          connections[id] = next;
        }
        return {
          version: 1, sampledAt: sample.sampledAt, uptimeSeconds: sample.uptimeSeconds,
          bootWindow: sameBoot ? {
            min: Math.max(currentState.bootWindow.min, sample.bootWindow.min),
            max: Math.min(currentState.bootWindow.max, sample.bootWindow.max),
          } : sample.bootWindow,
          connections,
        };
      });
    },
    async remove(id) {
      await update(current => {
        if (!current || !Object.hasOwn(current.connections, id)) return undefined;
        const connections = { ...current.connections };
        delete connections[id];
        return { ...current, connections };
      });
    },
  };
}
import { DataTypes, Transaction } from 'sequelize';
