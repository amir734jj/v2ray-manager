import minBy from 'lodash/minBy.js';

export function createTrafficMeter({ now = () => performance.now(), wallNow = () => Date.now(), upstream = false } = {}) {
  const sockets = new Map();
  const groups = new Map();
  const uploadCounter = upstream ? 'bytesWritten' : 'bytesRead';
  const downloadCounter = upstream ? 'bytesRead' : 'bytesWritten';
  let closedUploadBytes = 0;
  let closedDownloadBytes = 0;
  let previousUploadBytes = 0;
  let previousDownloadBytes = 0;
  let sampledAt = now();
  let rate = { intervalSeconds: null, uploadBytesPerSecond: null, downloadBytesPerSecond: null };

  function socketTotals(socket, baseline) {
    return {
      uploadBytes: socket[uploadCounter] - baseline.upload,
      downloadBytes: socket[downloadCounter] - baseline.download,
    };
  }

  function totals() {
    let uploadBytes = closedUploadBytes;
    let downloadBytes = closedDownloadBytes;
    for (const [socket, baseline] of sockets) {
      const current = socketTotals(socket, baseline);
      uploadBytes += current.uploadBytes;
      downloadBytes += current.downloadBytes;
    }
    return { uploadBytes, downloadBytes };
  }

  function groupTotals(group) {
    let uploadBytes = group.closedUploadBytes;
    let downloadBytes = group.closedDownloadBytes;
    for (const [socket, baseline] of group.sockets) {
      const current = socketTotals(socket, baseline);
      uploadBytes += current.uploadBytes;
      downloadBytes += current.downloadBytes;
    }
    return { uploadBytes, downloadBytes };
  }

  function observeGroupTraffic(baseline, current, observedAt) {
    if (!baseline.group) return;
    if (current.uploadBytes !== baseline.observedUploadBytes || current.downloadBytes !== baseline.observedDownloadBytes) {
      baseline.group.lastTrafficAt = observedAt;
    }
    baseline.observedUploadBytes = current.uploadBytes;
    baseline.observedDownloadBytes = current.downloadBytes;
  }

  function track(socket, bufferedBytes = 0, detailed = false, { groupId, connectedAt } = {}) {
    const baseline = {
      upload: socket[uploadCounter] - (upstream ? 0 : bufferedBytes),
      download: socket[downloadCounter] - (upstream ? bufferedBytes : 0),
    };
    if (groupId) {
      if (!groups.has(groupId)) {
        groups.set(groupId, {
          sockets: new Map(),
          closedUploadBytes: 0,
          closedDownloadBytes: 0,
          previousUploadBytes: 0,
          previousDownloadBytes: 0,
          lastTrafficAt: null,
          lastConnectedSince: null,
          rate: { intervalSeconds: null, uploadBytesPerSecond: null, downloadBytesPerSecond: null },
        });
      }
      baseline.group = groups.get(groupId);
      baseline.connectedAt = connectedAt ?? new Date(wallNow()).toISOString();
      if (baseline.group.sockets.size === 0) baseline.group.lastConnectedSince = baseline.connectedAt;
      baseline.observedUploadBytes = 0;
      baseline.observedDownloadBytes = 0;
      baseline.group.sockets.set(socket, baseline);
    }
    if (detailed) {
      baseline.details = {
        sampledUploadBytes: 0,
        sampledDownloadBytes: 0,
        intervalSeconds: null,
        uploadBytesPerSecond: null,
        downloadBytesPerSecond: null,
      };
    }
    sockets.set(socket, baseline);
    socket.once('close', () => {
      const current = socketTotals(socket, baseline);
      if (baseline.group) {
        baseline.group.lastConnectedSince = minBy([...baseline.group.sockets.values()], 'connectedAt')?.connectedAt;
        observeGroupTraffic(baseline, current, new Date(wallNow()).toISOString());
        baseline.group.closedUploadBytes += current.uploadBytes;
        baseline.group.closedDownloadBytes += current.downloadBytes;
        baseline.group.sockets.delete(socket);
      }
      closedUploadBytes += current.uploadBytes;
      closedDownloadBytes += current.downloadBytes;
      sockets.delete(socket);
    });
    if (detailed) {
      return {
        snapshot: () => ({
          ...socketTotals(socket, baseline),
          intervalSeconds: baseline.details.intervalSeconds,
          uploadBytesPerSecond: baseline.details.uploadBytesPerSecond,
          downloadBytesPerSecond: baseline.details.downloadBytesPerSecond,
        }),
      };
    }
  }

  function sample() {
    const currentTime = now();
    const intervalSeconds = (currentTime - sampledAt) / 1000;
    if (intervalSeconds <= 0) return;
    const { uploadBytes, downloadBytes } = totals();
    rate = {
      intervalSeconds,
      uploadBytesPerSecond: (uploadBytes - previousUploadBytes) / intervalSeconds,
      downloadBytesPerSecond: (downloadBytes - previousDownloadBytes) / intervalSeconds,
    };
    const observedAt = new Date(wallNow()).toISOString();
    for (const [socket, baseline] of sockets) {
      if (!baseline.details && !baseline.group) continue;
      const current = socketTotals(socket, baseline);
      observeGroupTraffic(baseline, current, observedAt);
      if (!baseline.details) continue;
      const details = baseline.details;
      details.intervalSeconds = intervalSeconds;
      details.uploadBytesPerSecond = (current.uploadBytes - details.sampledUploadBytes) / intervalSeconds;
      details.downloadBytesPerSecond = (current.downloadBytes - details.sampledDownloadBytes) / intervalSeconds;
      details.sampledUploadBytes = current.uploadBytes;
      details.sampledDownloadBytes = current.downloadBytes;
    }
    for (const group of groups.values()) {
      const current = groupTotals(group);
      group.rate = {
        intervalSeconds,
        uploadBytesPerSecond: (current.uploadBytes - group.previousUploadBytes) / intervalSeconds,
        downloadBytesPerSecond: (current.downloadBytes - group.previousDownloadBytes) / intervalSeconds,
      };
      group.previousUploadBytes = current.uploadBytes;
      group.previousDownloadBytes = current.downloadBytes;
    }
    sampledAt = currentTime;
    previousUploadBytes = uploadBytes;
    previousDownloadBytes = downloadBytes;
  }

  function groupSnapshot(id) {
    const group = groups.get(id);
    const connectedSince = minBy([...(group?.sockets.values() ?? [])], 'connectedAt')?.connectedAt ?? null;
    return {
      openTunnels: group?.sockets.size ?? 0,
      connectedSince,
      lastConnectedSince: connectedSince ?? group?.lastConnectedSince ?? null,
      lastTrafficAt: group?.lastTrafficAt ?? null,
      traffic: group ? { ...groupTotals(group), ...group.rate } : {
        uploadBytes: 0,
        downloadBytes: 0,
        intervalSeconds: rate.intervalSeconds,
        uploadBytesPerSecond: rate.intervalSeconds === null ? null : 0,
        downloadBytesPerSecond: rate.intervalSeconds === null ? null : 0,
      },
    };
  }

  return { track, sample, groupSnapshot, rates: () => ({ ...rate }), snapshot: () => ({ ...totals(), ...rate }) };
}
