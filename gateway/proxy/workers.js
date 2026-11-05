import { fork } from 'node:child_process';
import { parsePort } from '../services/config.js';

export async function createRouteWorkers({ upstreamHost, ports, logger, onError }) {
  const routes = Object.entries(ports).map(([protocol, port]) => ({
    protocol,
    target: `http://${upstreamHost}:${parsePort(port, `/${protocol} upstream port`)}`,
  }));
  const children = [];
  let closing = false;
  let closePromise;

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = Promise.all(children.map(child => new Promise(resolve => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        logger.warn({ pid: child.pid }, 'Proxy worker shutdown timed out; terminating worker');
        child.kill('SIGKILL');
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      if (child.connected) {
        child.send({ type: 'stop' }, error => {
          if (error && child.exitCode === null && child.signalCode === null) {
            logger.error({ err: error, pid: child.pid }, 'Proxy worker shutdown message failed');
            child.kill('SIGKILL');
          }
        });
      } else {
        child.kill('SIGKILL');
      }
    })));
    return closePromise;
  }

  const workerPorts = {};
  try {
    for (const { protocol, target } of routes) {
      const env = { ...process.env };
      delete env.DATABASE_URL;
      const child = fork(new URL('./worker.js', import.meta.url), [protocol, target], {
        env,
        execArgv: [],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      const port = await new Promise((resolve, reject) => {
        let ready = false;
        const timer = setTimeout(() => reject(new Error(`${protocol} proxy worker startup timed out`)), 10000);
        child.on('message', message => {
          if (ready || message?.type !== 'ready') return;
          try {
            const port = parsePort(message.port, `${protocol} worker port`);
            ready = true;
            clearTimeout(timer);
            resolve(port);
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
        child.on('error', error => {
          clearTimeout(timer);
          if (!ready) reject(error);
          else if (!closing) onError(error);
        });
        child.on('exit', (code, signal) => {
          clearTimeout(timer);
          const error = new Error(`${protocol} proxy worker exited (code ${code}, signal ${signal})`);
          if (!ready) reject(error);
          else if (!closing) onError(error);
        });
      });
      workerPorts[protocol] = port;
      logger.info({ protocol, pid: child.pid, port }, 'Proxy route worker ready');
    }
    return { ports: workerPorts, close };
  } catch (error) {
    await close();
    throw error;
  }
}
