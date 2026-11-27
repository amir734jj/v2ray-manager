export function createSnapshotCache(load, { ttl = 100, now = () => performance.now() } = {}) {
  let entry = null;
  function get() {
    if (entry && entry.expiresAt > now()) return entry.promise;
    const current = { expiresAt: Infinity };
    current.promise = Promise.resolve().then(load).then(value => {
      if (entry !== current) return get();
      current.expiresAt = now() + ttl;
      return value;
    }, error => {
      if (entry === current) entry = null;
      throw error;
    });
    entry = current;
    return current.promise;
  }
  return { get, invalidate: () => { entry = null; } };
}
