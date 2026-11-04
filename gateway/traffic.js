export function createTrafficMeter({ now = () => performance.now(), upstream = false } = {}) {
  const sockets = new Map();
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

  function track(socket, bufferedBytes = 0, detailed = false) {
    const baseline = {
      upload: socket[uploadCounter] - (upstream ? 0 : bufferedBytes),
      download: socket[downloadCounter] - (upstream ? bufferedBytes : 0),
    };
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
    for (const [socket, baseline] of sockets) {
      if (!baseline.details) continue;
      const current = socketTotals(socket, baseline);
      const details = baseline.details;
      details.intervalSeconds = intervalSeconds;
      details.uploadBytesPerSecond = (current.uploadBytes - details.sampledUploadBytes) / intervalSeconds;
      details.downloadBytesPerSecond = (current.downloadBytes - details.sampledDownloadBytes) / intervalSeconds;
      details.sampledUploadBytes = current.uploadBytes;
      details.sampledDownloadBytes = current.downloadBytes;
    }
    sampledAt = currentTime;
    previousUploadBytes = uploadBytes;
    previousDownloadBytes = downloadBytes;
  }

  return { track, sample, rates: () => ({ ...rate }), snapshot: () => ({ ...totals(), ...rate }) };
}
