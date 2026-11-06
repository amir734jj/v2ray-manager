import lodash from 'lodash';
import { createTrafficMeter } from '../services/traffic.js';

export function logUpstreamTraffic(proxy, logger, paths) {
  const meters = new Map(lodash.map([...paths], path => [path, createTrafficMeter({ upstream: true })]));
  const onRequest = (request, incomingRequest) => {
    const traffic = meters.get(incomingRequest.url);
    if (!traffic) throw new Error('Unknown upstream traffic route');
    // Measure before the handshake is written, including failed upstream attempts.
    request.once('socket', socket => traffic.track(socket));
  };
  proxy.on('proxyReqWs', onRequest);
  const timer = setInterval(() => {
    for (const [path, traffic] of meters) {
      traffic.sample();
      const {
        intervalSeconds, uploadBytes, downloadBytes, uploadBytesPerSecond, downloadBytesPerSecond,
      } = traffic.snapshot();
      logger.info({
        protocol: path.slice(1),
        intervalSeconds: Number(intervalSeconds.toFixed(2)),
        gatewayToV2rayMbps: Number((uploadBytesPerSecond * 8 / 1e6).toFixed(3)),
        v2rayToGatewayMbps: Number((downloadBytesPerSecond * 8 / 1e6).toFixed(3)),
        gatewayToV2rayBytes: uploadBytes,
        v2rayToGatewayBytes: downloadBytes,
      }, 'Gateway upstream throughput');
    }
  }, 5000);
  timer.unref();
  return () => {
    clearInterval(timer);
    proxy.off('proxyReqWs', onRequest);
  };
}
