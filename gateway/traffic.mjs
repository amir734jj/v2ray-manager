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

  function totals() {
    let uploadBytes = closedUploadBytes;
    let downloadBytes = closedDownloadBytes;
    for (const [socket, baseline] of sockets) {
      uploadBytes += socket[uploadCounter] - baseline.upload;
      downloadBytes += socket[downloadCounter] - baseline.download;
    }
    return { uploadBytes, downloadBytes };
  }

  function track(socket, bufferedBytes = 0) {
    const baseline = {
      upload: socket[uploadCounter] - (upstream ? 0 : bufferedBytes),
      download: socket[downloadCounter] - (upstream ? bufferedBytes : 0),
    };
    sockets.set(socket, baseline);
    socket.once('close', () => {
      closedUploadBytes += socket[uploadCounter] - baseline.upload;
      closedDownloadBytes += socket[downloadCounter] - baseline.download;
      sockets.delete(socket);
    });
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
    sampledAt = currentTime;
    previousUploadBytes = uploadBytes;
    previousDownloadBytes = downloadBytes;
  }

  return { track, sample, snapshot: () => ({ ...totals(), ...rate }) };
}
