try {
  const response = await fetch(`http://127.0.0.1:${process.env.GATEWAY_PORT ?? '53217'}/healthz`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`WebSocket health check returned ${response.status}`);
} catch (error) {
  console.error('Gateway health check failed:', error.message);
  process.exitCode = 1;
}
