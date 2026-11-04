import { cpuUsage, memoryUsage } from 'node:process';

export function createResourceMeter({
  now = () => performance.now(),
  readCpu = cpuUsage,
  readMemory = memoryUsage,
} = {}) {
  let previousCpu = readCpu();
  let sampledAt = now();
  let intervalSeconds = null;
  let cpuPercent = null;

  function sample() {
    const currentTime = now();
    const elapsedMilliseconds = currentTime - sampledAt;
    if (elapsedMilliseconds <= 0) return;
    const currentCpu = readCpu();
    const elapsedCpu = currentCpu.user - previousCpu.user + currentCpu.system - previousCpu.system;
    intervalSeconds = elapsedMilliseconds / 1000;
    cpuPercent = elapsedCpu / (elapsedMilliseconds * 1000) * 100;
    previousCpu = currentCpu;
    sampledAt = currentTime;
  }

  function snapshot() {
    const { rss, heapUsed, heapTotal, external, arrayBuffers } = readMemory();
    return {
      intervalSeconds,
      cpuPercent,
      memory: { rssBytes: rss, heapUsedBytes: heapUsed, heapTotalBytes: heapTotal, externalBytes: external, arrayBuffersBytes: arrayBuffers },
    };
  }

  return { sample, snapshot };
}
