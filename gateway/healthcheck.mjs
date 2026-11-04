import { connect } from 'node:http2';

const signal = AbortSignal.timeout(4000);
const session = connect(`http://127.0.0.1:${process.env.GATEWAY_GRPC_PORT ?? '53317'}`);
try {
  await Promise.all([
    fetch(`http://127.0.0.1:${process.env.GATEWAY_PORT ?? '53217'}/healthz`, { signal })
      .then(response => {
        if (!response.ok) throw new Error(`WebSocket health check returned ${response.status}`);
      }),
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      session.once('error', reject);
      const request = session.request({ ':path': '/healthz' });
      request.once('response', headers => {
        if (headers[':status'] !== 200) reject(new Error(`gRPC health check returned ${headers[':status']}`));
      });
      request.once('error', reject);
      request.once('end', resolve);
      request.resume();
      request.end();
    }),
  ]);
} catch (error) {
  console.error('Gateway health check failed:', error.message);
  process.exitCode = 1;
} finally {
  session.destroy();
}
