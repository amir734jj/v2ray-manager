export function createTunnelDiagnostics({ enabled = false, logger, now = () => performance.now(), onChange = () => {} }) {
  const recentEvents = [];
  let lastEventLoopDelay = null;

  function record(type, fields, severity) {
    recentEvents.unshift({
      type,
      severity,
      observedAt: fields.closedAt ?? fields.observedAt,
      connectionId: fields.connectionId ?? null,
      tunnelId: fields.tunnelId ?? null,
      subscriptionName: fields.subscriptionName ?? null,
      ip: fields.ip ?? null,
      protocol: fields.protocol ?? null,
      statusCode: fields.handshakeStatus ?? fields.statusCode ?? null,
      durationMs: fields.durationMs ?? null,
      handshakeMs: fields.handshakeMs ?? null,
      firstObservedClose: fields.firstObservedClose ? { ...fields.firstObservedClose } : null,
      gatewayReason: fields.gatewayReason ?? fields.reason ?? null,
      socketError: fields.socketError ? { ...fields.socketError } : null,
      hadError: Boolean(fields.hadError),
      socketPeerIp: fields.socketPeerIp ?? null,
      upstreamAddress: fields.upstreamAddress ?? null,
      upstreamPort: fields.upstreamPort ?? null,
      uploadBytes: fields.uploadBytes ?? null,
      downloadBytes: fields.downloadBytes ?? null,
      upstreamUploadBytes: fields.upstreamUploadBytes ?? null,
      upstreamDownloadBytes: fields.upstreamDownloadBytes ?? null,
      activeIpCount: fields.activeIpCount ?? null,
      maxConcurrentIps: fields.maxConcurrentIps ?? null,
    });
    if (recentEvents.length > 50) recentEvents.pop();
    onChange();
  }

  return {
    enabled,
    snapshot: () => ({
      enabled,
      eventLimit: 50,
      recentEvents: recentEvents.slice(),
      lastEventLoopDelay: lastEventLoopDelay ? { ...lastEventLoopDelay } : null,
    }),
    rejected(client, statusCode, reason, details = {}) {
      if (!enabled) return;
      const fields = { ...client, observedAt: new Date().toISOString(), statusCode, reason, ...details };
      logger.warn(fields, 'Tunnel handshake rejected');
      record('rejected', fields, 'warning');
    },
    track(socket, client, bufferedBytes = 0) {
      if (!enabled) return null;
      const startedAt = now();
      const baseline = { upload: socket.bytesRead - bufferedBytes, download: socket.bytesWritten };
      const socketPeerIp = socket.remoteAddress ?? null;
      let firstObservedClose = null;
      let gatewayReason = null;
      let socketError = null;
      let handshakeStatus = null;
      let handshakeMs = null;
      let upstream = null;
      let upstreamBaseline;
      let upstreamAddress = null;
      let upstreamPort = null;
      let closed = false;

      function captureUpstreamEndpoint(targetSocket) {
        upstreamAddress = targetSocket?.remoteAddress ?? upstreamAddress;
        upstreamPort = targetSocket?.remotePort ?? upstreamPort;
      }

      function observe(side, event, error) {
        firstObservedClose ??= { side, event };
        if (error) socketError ??= { side, code: error.code ?? 'UNKNOWN', syscall: error.syscall ?? null };
      }

      function handshake(statusCode) {
        if (closed || handshakeStatus !== null) return;
        captureUpstreamEndpoint(upstream);
        handshakeStatus = statusCode;
        handshakeMs = Math.max(0, now() - startedAt);
        logger.info({ ...client, observedAt: new Date().toISOString(), statusCode, handshakeMs }, 'Tunnel upstream handshake');
      }

      socket.once('end', () => observe('client-facing', 'end'));
      socket.once('error', error => observe('client-facing', 'error', error));
      socket.once('close', hadError => {
        observe('client-facing', 'close');
        closed = true;
        const fields = {
          ...client,
          closedAt: new Date().toISOString(),
          durationMs: Math.max(0, now() - startedAt),
          handshakeStatus,
          handshakeMs,
          firstObservedClose,
          gatewayReason,
          socketError,
          hadError: Boolean(hadError),
          socketPeerIp,
          upstreamAddress,
          upstreamPort,
          uploadBytes: socket.bytesRead - baseline.upload,
          downloadBytes: socket.bytesWritten - baseline.download,
          upstreamUploadBytes: upstream ? upstream.bytesWritten - upstreamBaseline.upload : null,
          upstreamDownloadBytes: upstream ? upstream.bytesRead - upstreamBaseline.download : null,
        };
        if (socketError || hadError || (handshakeStatus !== null && handshakeStatus !== 101)) {
          logger.warn(fields, 'Tunnel socket closed');
          record('closed', fields, 'warning');
        } else {
          logger.info(fields, 'Tunnel socket closed');
          record('closed', fields, 'info');
        }
      });

      return {
        request(request) {
          request.once('socket', targetSocket => {
            upstream = targetSocket;
            upstreamBaseline = { upload: upstream.bytesWritten, download: upstream.bytesRead };
            captureUpstreamEndpoint(upstream);
            upstream.once('connect', () => captureUpstreamEndpoint(upstream));
            upstream.once('end', () => observe('upstream', 'end'));
            upstream.once('error', error => observe('upstream', 'error', error));
            upstream.once('close', () => observe('upstream', 'close'));
          });
          request.once('upgrade', (response, targetSocket) => {
            captureUpstreamEndpoint(targetSocket);
            handshake(response.statusCode);
          });
          request.once('response', response => handshake(response.statusCode));
          request.once('error', error => observe('upstream', 'error', error));
        },
        gatewayClose(reason) {
          gatewayReason = reason;
          observe('gateway', 'destroy');
        },
        proxyError(error) {
          observe('upstream', 'error', error);
        },
      };
    },
    watchEventLoop() {
      if (!enabled) return () => {};
      let previousAt = now();
      const timer = setInterval(() => {
        const currentAt = now();
        const lagMs = Math.max(0, currentAt - previousAt - 1000);
        previousAt = currentAt;
        if (lagMs >= 250) {
          lastEventLoopDelay = { observedAt: new Date().toISOString(), lagMs };
          logger.warn(lastEventLoopDelay, 'Gateway event loop delayed');
          onChange();
        }
      }, 1000);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
