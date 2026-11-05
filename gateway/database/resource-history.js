import { ClassicLevel } from 'classic-level';
import createError from 'http-errors';
import { createTrafficUsage } from './traffic-usage.js';

export const RESOURCE_RANGES = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

const RETENTION_MS = RESOURCE_RANGES['24h'];
const BUCKETS = 300;
const CLEANUP_BATCH = 256;
const REQUIRED_METRICS = ['cpuPercent', 'rssBytes', 'heapUsedBytes', 'heapTotalBytes'];
const OPTIONAL_METRICS = [
  'uploadBytesPerSecond', 'downloadBytesPerSecond',
  'openClientSockets', 'connectionAttempts', 'proxyFailures',
];
const METRICS = [...REQUIRED_METRICS, ...OPTIONAL_METRICS];

function keyFor(timestamp) {
  return String(Math.max(0, Math.floor(timestamp))).padStart(16, '0');
}

function createSeries() {
  return Object.fromEntries(METRICS.map(metric => [metric, { min: null, max: null, count: 0, buckets: new Map() }]));
}

function validateSample(sample) {
  if (!sample || !Number.isSafeInteger(sample.timestamp) || sample.timestamp < 0) {
    throw new Error('Invalid resource history timestamp');
  }
  for (const metric of REQUIRED_METRICS) {
    if (!Number.isFinite(sample[metric])) throw new Error(`Invalid resource history value for ${metric}`);
  }
  for (const metric of OPTIONAL_METRICS) {
    if (sample[metric] !== undefined && !Number.isFinite(sample[metric])) {
      throw new Error(`Invalid resource history value for ${metric}`);
    }
  }
}

function addToSeries(series, sample, start, duration) {
  validateSample(sample);
  const bucketIndex = Math.min(BUCKETS - 1, Math.max(0, Math.floor((sample.timestamp - start) / duration * BUCKETS)));
  for (const metric of METRICS) {
    const value = sample[metric];
    if (value === undefined) continue;
    const state = series[metric];
    state.count++;
    state.min = state.min === null ? value : Math.min(state.min, value);
    state.max = state.max === null ? value : Math.max(state.max, value);
    const point = { timestamp: sample.timestamp, value };
    const bucket = state.buckets.get(bucketIndex);
    if (!bucket) state.buckets.set(bucketIndex, { min: point, max: point });
    else {
      if (value < bucket.min.value) bucket.min = point;
      if (value > bucket.max.value) bucket.max = point;
    }
  }
}

function finishSeries(series) {
  return Object.fromEntries(METRICS.map(metric => {
    const { min, max, count, buckets } = series[metric];
    const points = [...buckets.values()].flatMap(bucket => {
      if (bucket.min.timestamp === bucket.max.timestamp) return [bucket.min];
      return [bucket.min, bucket.max].sort((a, b) => a.timestamp - b.timestamp);
    });
    return [metric, { min, max, count, points }];
  }));
}

class ResourceHistory {
  constructor(database, trafficUsage, clock = Date.now) {
    this.database = database;
    this.trafficUsage = trafficUsage;
    this.clock = clock;
  }

  async pruneBatch() {
    const operations = [];
    for await (const key of this.database.keys({
      gte: keyFor(0),
      lt: keyFor(this.clock() - RETENTION_MS),
      limit: CLEANUP_BATCH,
      fillCache: false,
    })) {
      operations.push({ type: 'del', key });
    }
    if (operations.length) await this.database.batch(operations);
    return operations.length;
  }

  async pruneExpired() {
    while (await this.pruneBatch() === CLEANUP_BATCH) {}
  }

  async record(sample) {
    validateSample(sample);
    await this.database.put(keyFor(sample.timestamp), sample);
    await this.pruneBatch();
  }

  async read(range) {
    if (typeof range !== 'string' || !Object.hasOwn(RESOURCE_RANGES, range)) {
      throw createError(400, 'Invalid resource history range');
    }
    const duration = RESOURCE_RANGES[range];
    const end = this.clock();
    const start = end - duration;
    const series = createSeries();
    let count = 0;
    for await (const [, sample] of this.database.iterator({
      gte: keyFor(start), lte: keyFor(end), fillCache: false,
    })) {
      addToSeries(series, sample, start, duration);
      count++;
    }
    return { start, end, count, series: finishSeries(series) };
  }

  close() {
    return this.database.close();
  }
}

export async function createResourceHistory(path) {
  const database = new ClassicLevel(path, {
    valueEncoding: 'json',
    cacheSize: 256 * 1024,
    writeBufferSize: 1024 * 1024,
  });
  await database.open();
  try {
    const trafficUsage = await createTrafficUsage(database.sublevel('subscription-traffic', { valueEncoding: 'json' }));
    const history = new ResourceHistory(database, trafficUsage);
    await history.pruneExpired();
    return history;
  } catch (error) {
    await database.close();
    throw error;
  }
}
