import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import lodash from 'lodash';

const MAX_PENDING = 10000;

export function parseDestination(message) {
  if (typeof message !== 'string' || message.length > 4096) return null;
  const match = /^\S+ accepted (?:tcp|udp):([^\s:]+):([0-9]{1,5})(?: \[[^\]\r\n]*\])? email: connection-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(message);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return null;
  if (/[/\\@?#%]/.test(match[1])) return null;
  const domain = domainToASCII(match[1]).toLowerCase().replace(/\.$/, '');
  if (!domain || domain.length > 253 || isIP(domain)
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(domain)) return null;
  return { connectionId: match[3], domain };
}

export function createDestinationMonitor({ api, store, listIds, logger, onChange, clock = Date.now }) {
  let pending = new Map();
  let stream;
  let retry;
  let stopping = false;
  let connected = false;
  let streamError = null;
  let storageError = null;
  let overflow = false;
  let previousOverflow = false;
  let pendingFlush = null;
  const removedIds = new Set();

  function failed(error) {
    if (stopping || retry) return;
    connected = false;
    streamError = 'Domain collection is unavailable; recent destinations may be incomplete. Check V2Ray LoggerService and gateway logs.';
    logger.warn({ errorCode: error?.code }, 'V2Ray destination log stream disconnected');
    retry = setTimeout(() => {
      retry = undefined;
      connect();
    }, 5000);
    retry.unref();
    onChange();
  }

  function connect() {
    try {
      stream = api.followLogs();
      stream.on('metadata', () => {
        connected = true;
        streamError = null;
        onChange();
      });
      stream.on('data', response => {
        const destination = parseDestination(response.message);
        if (!destination) return;
        const key = `${destination.connectionId}:${destination.domain}`;
        if (!pending.has(key) && pending.size >= MAX_PENDING) {
          if (!overflow) {
            logger.warn('Destination collection buffer is full; some domain observations were dropped');
            overflow = true;
            onChange();
          }
          return;
        }
        pending.set(key, { ...destination, lastSeen: clock() });
      });
      stream.on('error', failed);
      stream.on('end', () => failed());
    } catch (error) {
      failed(error);
    }
  }

  return {
    start: connect,
    stop() {
      stopping = true;
      clearTimeout(retry);
      stream?.cancel();
    },
    status() {
      return {
        status: streamError || storageError || overflow || previousOverflow ? 'error' : connected ? 'ready' : 'loading',
        error: lodash.compact([
          streamError, storageError,
          overflow || previousOverflow ? 'Some domain observations were dropped because the collection buffer was full.' : null,
        ]).join(' ') || null,
      };
    },
    flush() {
      if (pendingFlush) return pendingFlush;
      pendingFlush = flush().finally(() => {
        pendingFlush = null;
        onChange();
      });
      return pendingFlush;
    },
    async remove(id) {
      removedIds.add(id);
      for (const [key, observation] of pending) {
        if (observation.connectionId === id) pending.delete(key);
      }
      await pendingFlush;
      await store.remove(id);
    },
  };

  async function flush() {
    const batch = pending;
    pending = new Map();
    const dropped = overflow;
    overflow = false;
    try {
      const ids = await listIds();
      const activeIds = lodash.filter(ids, id => !removedIds.has(id));
      await store.record([...batch.values()], activeIds);
      const knownIds = new Set(ids);
      for (const id of removedIds) {
        if (!knownIds.has(id)) removedIds.delete(id);
      }
      storageError = null;
      previousOverflow = dropped;
    } catch (error) {
      storageError = 'Recent destinations could not be saved; displayed history may be stale. Check gateway logs and the SQLite store.';
      logger.warn({ errorName: error.name, errorCode: error.original?.code ?? error.code }, 'Destination persistence failed');
      for (const [key, observation] of batch) {
        if (pending.has(key)) continue;
        if (pending.size >= MAX_PENDING) {
          overflow = true;
          break;
        }
        pending.set(key, observation);
      }
    }
  }
}
