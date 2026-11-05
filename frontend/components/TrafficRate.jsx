import prettyBytes from 'pretty-bytes';

export default function TrafficRate({ value }) {
  if (value === null) return 'Collecting...';
  return `${prettyBytes(value, { binary: true })}/s`;
}
