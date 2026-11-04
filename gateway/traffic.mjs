export function createTrafficMeter({ now = () => performance.now() } = {}) {
  const sockets = new Map();
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
      uploadBytes += socket.bytesRead - baseline.upload;
      downloadBytes += socket.bytesWritten - baseline.download;
    }
    return { uploadBytes, downloadBytes };
  }

  function track(socket, bufferedBytes = 0) {
    const baseline = {
      upload: socket.bytesRead - bufferedBytes,
      download: socket.bytesWritten,
    };
    sockets.set(socket, baseline);
    socket.once('close', () => {
      closedUploadBytes += socket.bytesRead - baseline.upload;
      closedDownloadBytes += socket.bytesWritten - baseline.download;
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
