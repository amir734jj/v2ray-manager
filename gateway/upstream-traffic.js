import { createTrafficMeter } from './traffic.js';

export function logUpstreamTraffic(proxy, logger) {
  const traffic = createTrafficMeter({ upstream: true });
  const onRequest = request => {
    // Measure before the handshake is written, including failed upstream attempts.
    request.once('socket', socket => traffic.track(socket));
  };
  proxy.on('proxyReqWs', onRequest);
  const timer = setInterval(() => {
    traffic.sample();
    const {
      intervalSeconds, uploadBytes, downloadBytes, uploadBytesPerSecond, downloadBytesPerSecond,
    } = traffic.snapshot();
    logger.info({
      intervalSeconds: Number(intervalSeconds.toFixed(2)),
      gatewayToV2rayMbps: Number((uploadBytesPerSecond * 8 / 1e6).toFixed(3)),
      v2rayToGatewayMbps: Number((downloadBytesPerSecond * 8 / 1e6).toFixed(3)),
      gatewayToV2rayBytes: uploadBytes,
      v2rayToGatewayBytes: downloadBytes,
    }, 'Gateway upstream throughput');
  }, 5000);
  timer.unref();
  return () => {
    clearInterval(timer);
    proxy.off('proxyReqWs', onRequest);
  };
}
