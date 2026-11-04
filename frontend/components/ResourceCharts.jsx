import { useEffect, useState } from 'preact/hooks';
import prettyBytes from 'pretty-bytes';
import { api, errorMessage } from '../api.mjs';

const ranges = [
  ['5m', 'Last 5 minutes'],
  ['15m', 'Last 15 minutes'],
  ['1h', 'Last hour'],
  ['6h', 'Last 6 hours'],
  ['24h', 'Last 24 hours'],
];
const metrics = [
  { key: 'cpuPercent', label: 'CPU usage', format: value => `${value.toFixed(1)}%` },
  { key: 'rssBytes', label: 'Resident memory (RSS)', format: value => prettyBytes(value, { binary: true }) },
  { key: 'heapUsedBytes', label: 'JavaScript heap used', format: value => prettyBytes(value, { binary: true }) },
  { key: 'heapTotalBytes', label: 'JavaScript heap allocated', format: value => prettyBytes(value, { binary: true }) },
];

function ResourceChart({ metric, history }) {
  const series = history?.series[metric.key];
  if (!series?.points.length) return <div class="col-12 col-lg-6"><div class="card h-100"><div class="card-body">
    <h3 class="h6">{metric.label}</h3>
    <p class="text-body-secondary mb-0">No samples in this time range.</p>
  </div></div></div>;

  const { min, max, points } = series;
  const top = min === max ? max + Math.max(1, Math.abs(max) * 0.05) : max;
  const bottom = min === max ? Math.max(0, min - Math.max(1, Math.abs(min) * 0.05)) : min;
  const coordinates = points.map(point => {
    const x = (point.timestamp - history.start) / (history.end - history.start) * 600;
    const y = 90 - (point.value - bottom) / (top - bottom) * 80;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return <div class="col-12 col-lg-6"><div class="card h-100"><div class="card-body">
    <h3 class="h6">{metric.label}</h3>
    <p class="small text-body-secondary mb-1">Lowest: {metric.format(min)} · Highest: {metric.format(max)}</p>
    <svg viewBox="0 0 600 100" width="100%" height="120" preserveAspectRatio="none" role="img"
      aria-label={`${metric.label}: lowest ${metric.format(min)}, highest ${metric.format(max)} over ${history.count} samples`}>
      <line x1="0" x2="600" y1="90" y2="90" stroke="currentColor" opacity="0.3" />
      {points.length === 1
        ? <circle cx={coordinates.split(',')[0]} cy={coordinates.split(',')[1]} r="3" fill="currentColor" />
        : <polyline points={coordinates} fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" />}
    </svg>
    <div class="d-flex justify-content-between small text-body-secondary">
      <span>{new Date(history.start).toLocaleString()}</span>
      <span>{new Date(history.end).toLocaleString()}</span>
    </div>
  </div></div></div>;
}

export default function ResourceCharts() {
  const [range, setRange] = useState('1h');
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    let pending = false;
    const controller = new AbortController();
    setHistory(null);
    setLoading(true);
    setError('');
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await api.get('/api/resource-history', {
          params: { range }, signal: controller.signal,
        });
        if (active) {
          setHistory(response.data);
          setError('');
        }
      } catch (failure) {
        if (active && !controller.signal.aborted) {
          setError(`Resource history unavailable; displayed charts may be stale. ${errorMessage(failure)}`);
        }
      } finally {
        pending = false;
        if (active) setLoading(false);
      }
    };
    load();
    const timer = setInterval(load, 30000);
    return () => {
      active = false;
      clearInterval(timer);
      controller.abort();
    };
  }, [range, retry]);

  return <section class="mb-4" aria-label="Gateway resource history">
    <div class="d-flex flex-wrap align-items-center gap-3 mb-2">
      <h2 class="h4 mb-0">Resource history</h2>
      <label for="resource-range">Time range</label>
      <select id="resource-range" class="form-select w-auto" value={range} onChange={event => setRange(event.currentTarget.value)}>
        {ranges.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select>
    </div>
    <p class="text-body-secondary">Samples are recorded every 5 seconds and charts refresh every 30 seconds. Lowest and highest include every sample in the selected range. Charts use independent scales and connect samples across gaps. Bun heap values may be inconsistent.</p>
    {loading && <p role="status">Loading resource history...</p>}
    {error && <div class="alert alert-danger" role="alert">{error} <button class="btn btn-sm btn-outline-danger" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
    {history?.recordingError && <div class="alert alert-warning" role="alert">{history.recordingError}</div>}
    {history && <div class="row g-3">
      {metrics.map(metric => <ResourceChart key={metric.key} metric={metric} history={history} />)}
    </div>}
  </section>;
}
