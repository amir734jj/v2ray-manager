import { join } from 'node:path';
import { DataTypes, Op, QueryTypes, Sequelize } from 'sequelize';
import createError from 'http-errors';
import lodash from 'lodash';
import { createTrafficUsage } from './traffic-usage.js';
import { createSubscriptionActivity } from './subscription-activity.js';
import { createDestinations } from './destinations.js';

export const RESOURCE_RANGES = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

const RETENTION_MS = RESOURCE_RANGES['24h'];
const BUCKETS = 300;
const READ_BATCH = 256;
const REQUIRED_METRICS = ['cpuPercent', 'rssBytes', 'heapUsedBytes', 'heapTotalBytes'];
const OPTIONAL_METRICS = [
  'uploadBytesPerSecond', 'downloadBytesPerSecond',
  'openClientSockets', 'connectionAttempts', 'proxyFailures',
];
const METRICS = [...REQUIRED_METRICS, ...OPTIONAL_METRICS];

function createSeries() {
  return lodash.fromPairs(lodash.map(METRICS, metric => [metric, { min: null, max: null, count: 0, buckets: new Map() }]));
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
  const bucketIndex = lodash.clamp(Math.floor((sample.timestamp - start) / duration * BUCKETS), 0, BUCKETS - 1);
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
  return lodash.mapValues(series, ({ min, max, count, buckets }) => {
    const points = lodash.flatMap([...buckets.values()], bucket => {
      if (bucket.min.timestamp === bucket.max.timestamp) return [bucket.min];
      return lodash.sortBy([bucket.min, bucket.max], 'timestamp');
    });
    return { min, max, count, points };
  });
}

class ResourceHistory {
  constructor(database, Sample, trafficUsage, subscriptionActivity, destinations, clock = Date.now) {
    this.database = database;
    this.Sample = Sample;
    this.trafficUsage = trafficUsage;
    this.subscriptionActivity = subscriptionActivity;
    this.destinations = destinations;
    this.clock = clock;
  }

  async pruneExpired() {
    await this.Sample.destroy({
      where: { timestamp: { [Op.lt]: this.clock() - RETENTION_MS } },
    });
  }

  async record(sample) {
    validateSample(sample);
    await this.Sample.upsert({ timestamp: sample.timestamp, sample });
    await this.pruneExpired();
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
    let after = start - 1;
    for (;;) {
      const rows = await this.Sample.findAll({
        attributes: ['timestamp', 'sample'],
        where: { timestamp: { [Op.gt]: after, [Op.lte]: end } },
        order: [['timestamp', 'ASC']],
        limit: READ_BATCH,
      });
      for (const { sample } of rows) {
        addToSeries(series, sample, start, duration);
        count++;
      }
      if (rows.length < READ_BATCH) break;
      after = Number(rows.at(-1).timestamp);
    }
    return { start, end, count, series: finishSeries(series) };
  }

  close() {
    return this.database.close();
  }
}

export async function createResourceHistory(path) {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: join(path, 'metrics.sqlite'),
    logging: false,
    retry: { match: [/SQLITE_BUSY/], max: 5 },
  });
  try {
    const [journal] = await database.query('PRAGMA journal_mode=WAL', { type: QueryTypes.SELECT });
    if (journal.journal_mode !== 'wal') throw new Error('The metrics database could not enable SQLite WAL mode');
    const Sample = database.define('ResourceSample', {
      timestamp: { type: DataTypes.BIGINT, primaryKey: true },
      sample: { type: DataTypes.JSON, allowNull: false },
    }, { tableName: 'gateway_resource_samples', timestamps: false });
    await Sample.sync();
    const trafficUsage = await createTrafficUsage(database);
    const subscriptionActivity = await createSubscriptionActivity(database);
    const destinations = await createDestinations(database);
    const history = new ResourceHistory(database, Sample, trafficUsage, subscriptionActivity, destinations);
    await history.pruneExpired();
    return history;
  } catch (error) {
    await database.close();
    throw error;
  }
}
