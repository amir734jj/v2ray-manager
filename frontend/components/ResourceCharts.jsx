import { useEffect, useRef, useState } from 'preact/hooks';
import prettyBytes from 'pretty-bytes';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { api, errorMessage } from '../api.js';

const ranges = [
  ['5m', 'Last 5 minutes'],
  ['15m', 'Last 15 minutes'],
  ['1h', 'Last hour'],
  ['6h', 'Last 6 hours'],
  ['24h', 'Last 24 hours'],
];
const metrics = [
  { key: 'openClientSockets', label: 'Open client sockets', format: value => value.toLocaleString() },
  { key: 'connectionAttempts', label: 'Connection attempts', format: value => value.toLocaleString() },
  { key: 'proxyFailures', label: 'Proxy failures', format: value => value.toLocaleString() },
  { key: 'cpuPercent', label: 'CPU usage', format: value => `${value.toFixed(1)}%` },
  { key: 'rssBytes', label: 'Resident memory (RSS)', format: value => prettyBytes(value, { binary: true }) },
  { key: 'heapUsedBytes', label: 'JavaScript heap used', format: value => prettyBytes(value, { binary: true }) },
  { key: 'heapTotalBytes', label: 'JavaScript heap allocated', format: value => prettyBytes(value, { binary: true }) },
  { key: 'uploadBytesPerSecond', label: 'Proxy upload (client to proxy)', format: value => `${prettyBytes(value, { binary: true })}/s` },
  { key: 'downloadBytesPerSecond', label: 'Proxy download (proxy to client)', format: value => `${prettyBytes(value, { binary: true })}/s` },
];

function plotData(points) {
  return [points.map(point => point.timestamp / 1000), points.map(point => point.value)];
}

function ResourcePlot({ metric, series, history }) {
  const container = useRef(null);
  const chart = useRef(null);
  const bounds = useRef(null);

  useEffect(() => {
    const color = getComputedStyle(container.current).getPropertyValue('--bs-body-color').trim() || '#adb5bd';
    const plot = new uPlot({
      width: Math.max(1, container.current.clientWidth),
      height: 190,
      tzDate: timestamp => new Date(timestamp * 1000),
      scales: { x: { time: true } },
      axes: [
        { stroke: color, grid: { stroke: 'rgba(128, 128, 128, 0.2)' } },
        { stroke: color, grid: { stroke: 'rgba(128, 128, 128, 0.2)' }, size: 90,
          values: (_plot, values) => values.map(metric.format) },
      ],
      series: [
        { label: 'Time', value: (_plot, value) => value == null ? '—' : new Date(value * 1000).toLocaleString() },
        { label: metric.label, stroke: '#6ea8fe', width: 2,
          value: (_plot, value) => value == null ? '—' : metric.format(value),
          points: { show: plot => plot.data[1].length === 1 } },
      ],
    }, plotData(series.points), container.current);
    chart.current = plot;
    const observer = new ResizeObserver(entries => {
      const width = Math.floor(entries[0].contentRect.width);
      if (width > 0) plot.setSize({ width, height: 190 });
    });
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      plot.destroy();
      chart.current = null;
      bounds.current = null;
    };
  }, [metric]);

  useEffect(() => {
    const plot = chart.current;
    if (!plot) return;
    const start = history.start / 1000;
    const end = history.end / 1000;
    const previous = bounds.current;
    const current = plot.scales.x;
    const zoomed = previous && (current.min > previous.start + 0.001 || current.max < previous.end - 0.001);
    const min = zoomed ? Math.max(start, current.min) : start;
    const max = zoomed ? Math.min(end, current.max) : end;
    plot.setData(plotData(series.points), false);
    plot.setScale('y', { min: null, max: null });
    plot.setScale('x', min < max ? { min, max } : { min: start, max: end });
    bounds.current = { start, end };
  }, [history, series]);

  return <>
    <div ref={container} role="img"
      aria-label={`${metric.label}: lowest ${metric.format(series.min)}, highest ${metric.format(series.max)} over ${series.count ?? history.count} samples`} />
    <button class="btn btn-sm btn-outline-secondary mt-2" onClick={() => {
      if (chart.current && bounds.current) chart.current.setScale('x', { min: bounds.current.start, max: bounds.current.end });
    }} aria-label={`Reset zoom for ${metric.label}`}>Reset zoom</button>
  </>;
}

function ResourceChart({ metric, history }) {
  const series = history?.series[metric.key];
  if (!series?.points.length) return <div class="col-12 col-lg-6"><div class="card h-100"><div class="card-body">
    <h3 class="h6">{metric.label}</h3>
    <p class="text-body-secondary mb-0">No samples in this time range.</p>
  </div></div></div>;

  return <div class="col-12 col-lg-6"><div class="card h-100"><div class="card-body">
    <h3 class="h6">{metric.label}</h3>
    <p class="small text-body-secondary mb-1">Lowest: {metric.format(series.min)} · Highest: {metric.format(series.max)}</p>
    <ResourcePlot metric={metric} series={series} history={history} />
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

  return <section class="mb-4" aria-label="Gateway metrics history">
    <div class="d-flex flex-wrap align-items-center gap-3 mb-2">
      <h2 class="h4 mb-0">Gateway metrics history</h2>
      <label for="resource-range">Time range</label>
      <select id="resource-range" class="form-select w-auto" value={range} onChange={event => setRange(event.currentTarget.value)}>
        {ranges.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select>
    </div>
    <p class="text-body-secondary">Samples are recorded every 5 seconds and charts refresh every 30 seconds. Connection attempts and proxy failures are cumulative and reset when the gateway restarts. Lowest and highest include every sample in the selected range, even when zoomed. Drag a chart to zoom; use Reset zoom to show the full range. Charts use independent scales and connect samples across gaps. Bun heap values may be inconsistent.</p>
    {loading && <p role="status">Loading resource history...</p>}
    {error && <div class="alert alert-danger" role="alert">{error} <button class="btn btn-sm btn-outline-danger" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
    {history?.recordingError && <div class="alert alert-warning" role="alert">{history.recordingError}</div>}
    {history && <div class="row g-3">
      {metrics.map(metric => <ResourceChart key={metric.key} metric={metric} history={history} />)}
    </div>}
  </section>;
}
