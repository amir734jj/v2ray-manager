import { useState } from 'preact/hooks';
import QRCode from 'qrcode';
import { api, errorMessage } from '../api.js';

function Download({ label, value, qr, filename, config }) {
  return <div class="border rounded p-3">
    <h4 class="h6">{label}</h4>
    <input class="form-control mb-2" aria-label={`${label} link`} value={value} readOnly
      onFocus={event => event.currentTarget.select()} />
    <img src={qr} alt={`${label} QR code`} width="192" height="192" class="d-block mb-2 mw-100" />
    <div class="d-flex flex-wrap gap-2">
      <a class="btn btn-sm btn-outline-primary" download={`${filename}.txt`}
        href={`data:text/plain;charset=utf-8,${encodeURIComponent(`${value}\n`)}`}>Download link</a>
      <a class="btn btn-sm btn-outline-primary" download={`${filename}-qr.png`} href={qr}>Download QR code</a>
      {config && <a class="btn btn-sm btn-outline-primary" download={`${filename}.json`}
        href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(config, null, 2) + '\n')}`}>Download JSON</a>}
    </div>
  </div>;
}

export default function SubscriptionDownloads({ connection }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [subscriptionQr, setSubscriptionQr] = useState('');
  const [profiles, setProfiles] = useState(null);
  const [combinedConfig, setCombinedConfig] = useState(null);

  async function load() {
    setOpen(true);
    setBusy(true);
    setError('');
    try {
      const qr = await QRCode.toDataURL(connection.subscriptionUrl, { width: 512, margin: 2 });
      setSubscriptionQr(qr);
      if (connection.enabled && connection.syncStatus === 'applied') {
        const { data } = await api.get(`/api/connections/${connection.id}/profiles`);
        const links = data.links;
        if (!Array.isArray(links) || !links.length || links.some(link => typeof link !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\//i.test(link))) {
          throw new Error('The subscription did not return valid connection links.');
        }
        const items = await Promise.all(links.map(async link => {
          const scheme = link.split('://', 1)[0];
          const protocol = scheme === 'ss' ? 'shadowsocks' : scheme;
          if (!data.configs?.[protocol]) throw new Error(`Missing ${protocol} JSON configuration.`);
          return { link, protocol, config: data.configs[protocol], qr: await QRCode.toDataURL(link, { width: 512, margin: 2 }) };
        }));
        if (!data.configs?.client) throw new Error('Missing combined JSON configuration.');
        setProfiles(items);
        setCombinedConfig(data.configs.client);
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <div class="mt-2">
    {!open ? <button class="btn btn-sm btn-outline-primary" onClick={load}>Show downloads and QR codes</button> : <>
      <button class="btn btn-sm btn-outline-secondary" onClick={() => setOpen(false)}>Hide downloads</button>
      {busy && <p class="mt-2" role="status">Preparing downloads...</p>}
      {error && <div class="alert alert-danger mt-2" role="alert">
        Could not prepare downloads: {error}
        <button class="btn btn-sm btn-outline-danger ms-2" onClick={load} disabled={busy}>Retry</button>
      </div>}
      <div class="d-grid gap-2 mt-2">
        {subscriptionQr && <Download label="Subscription" value={connection.subscriptionUrl}
          qr={subscriptionQr} filename="subscription" />}
        {combinedConfig && <a class="btn btn-sm btn-outline-primary justify-self-start" download="client.json"
          href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(combinedConfig, null, 2) + '\n')}`}>Download combined JSON</a>}
        {profiles?.map(({ protocol, link, qr, config }) => <Download key={protocol} label={protocol.toUpperCase()}
          value={link} qr={qr} filename={protocol} config={config} />)}
      </div>
      {!connection.enabled || connection.syncStatus !== 'applied'
        ? <p class="small text-body-secondary mt-2">Connection links are available when the subscription is enabled and synchronized.</p>
        : profiles && <p class="small text-body-secondary mt-2">
          The Shadowsocks link requires v2ray-plugin; v2rayNG users should import the subscription URL instead.
        </p>}
    </>}
  </div>;
}
