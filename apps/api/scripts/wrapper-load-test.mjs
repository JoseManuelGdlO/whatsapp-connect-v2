import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';

const TARGET_URL = process.env.TARGET_URL ?? 'http://127.0.0.1:3001';
const DEVICE_ID = process.env.DEVICE_ID ?? 'device-load';
const MOCK_TARGET = process.env.MOCK_TARGET === 'true';
const RESULT_PATH = process.env.RESULT_PATH ?? 'load-test-results.json';

function percentile(sortedNumbers, p) {
  if (sortedNumbers.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedNumbers.length) - 1;
  return sortedNumbers[Math.max(0, Math.min(idx, sortedNumbers.length - 1))];
}

async function runScenario({ name, total, concurrency, buildBody, endpoint }) {
  let cursor = 0;
  let success = 0;
  let failed = 0;
  const latencies = [];
  const errors = {};

  async function worker() {
    while (cursor < total) {
      const current = cursor;
      cursor += 1;

      const start = performance.now();
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify(buildBody(current))
        });
        const elapsed = performance.now() - start;
        latencies.push(elapsed);

        if (response.ok || response.status === 202) {
          success += 1;
        } else {
          failed += 1;
          const key = `http_${response.status}`;
          errors[key] = (errors[key] ?? 0) + 1;
        }
      } catch (err) {
        const elapsed = performance.now() - start;
        latencies.push(elapsed);
        failed += 1;
        const key = err instanceof Error ? err.name : 'unknown_error';
        errors[key] = (errors[key] ?? 0) + 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    name,
    total,
    concurrency,
    success,
    failed,
    p50Ms: Number(percentile(sorted, 50).toFixed(2)),
    p95Ms: Number(percentile(sorted, 95).toFixed(2)),
    p99Ms: Number(percentile(sorted, 99).toFixed(2)),
    avgMs: Number((latencies.reduce((acc, n) => acc + n, 0) / Math.max(1, latencies.length)).toFixed(2)),
    errors
  };
}

async function runSoak({ seconds, rps, endpoint }) {
  const startedAt = Date.now();
  const latencies = [];
  let success = 0;
  let failed = 0;
  const errors = {};
  let messageIndex = 0;

  while (Date.now() - startedAt < seconds * 1000) {
    const tickStart = performance.now();
    const burst = Array.from({ length: rps }, async () => {
      const start = performance.now();
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            to: `5219000${messageIndex++}`,
            type: 'text',
            text: 'soak-message'
          })
        });
        const elapsed = performance.now() - start;
        latencies.push(elapsed);
        if (response.ok || response.status === 202) success += 1;
        else {
          failed += 1;
          const key = `http_${response.status}`;
          errors[key] = (errors[key] ?? 0) + 1;
        }
      } catch (err) {
        const elapsed = performance.now() - start;
        latencies.push(elapsed);
        failed += 1;
        const key = err instanceof Error ? err.name : 'unknown_error';
        errors[key] = (errors[key] ?? 0) + 1;
      }
    });

    await Promise.all(burst);
    const elapsedTick = performance.now() - tickStart;
    const waitMs = Math.max(0, 1000 - elapsedTick);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    name: 'B_soak_test',
    durationSeconds: seconds,
    rps,
    total: success + failed,
    success,
    failed,
    p50Ms: Number(percentile(sorted, 50).toFixed(2)),
    p95Ms: Number(percentile(sorted, 95).toFixed(2)),
    p99Ms: Number(percentile(sorted, 99).toFixed(2)),
    avgMs: Number((latencies.reduce((acc, n) => acc + n, 0) / Math.max(1, latencies.length)).toFixed(2)),
    errors
  };
}

async function maybeStartMockServer() {
  if (!MOCK_TARGET) return null;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/devices/')) {
      const randomDelay = 20 + Math.floor(Math.random() * 80);
      const failRate = Number(process.env.MOCK_FAIL_RATE ?? '0.03');
      setTimeout(() => {
        if (Math.random() < failRate) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'temporary_unavailable' }));
          return;
        }
        res.statusCode = 202;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ outboundMessageId: `mock-${Date.now()}`, status: 'QUEUED' }));
      }, randomDelay);
      return;
    }
    res.statusCode = 404;
    res.end('not_found');
  });

  await new Promise((resolve) => server.listen(3800, '127.0.0.1', resolve));
  return server;
}

const endpoint = `${TARGET_URL}/devices/${DEVICE_ID}/messages/send`;
const startedAt = new Date().toISOString();
const mockServer = await maybeStartMockServer();

try {
  const burstSizes = [50, 100, 200];
  const burstConcurrency = [1, 2, 5, 10];
  const burstResults = [];

  for (const total of burstSizes) {
    for (const concurrency of burstConcurrency) {
      const result = await runScenario({
        name: `A_burst_${total}_c${concurrency}`,
        total,
        concurrency,
        endpoint,
        buildBody: (index) => ({
          to: `52161836${String(index).padStart(4, '0')}`,
          type: 'text',
          text: 'burst-message'
        })
      });
      burstResults.push(result);
    }
  }

  const soakResult = await runSoak({
    seconds: Number(process.env.SOAK_SECONDS ?? '20'),
    rps: Number(process.env.SOAK_RPS ?? '5'),
    endpoint
  });

  const output = {
    mode: MOCK_TARGET ? 'mock' : 'live',
    targetUrl: TARGET_URL,
    startedAt,
    finishedAt: new Date().toISOString(),
    scenarios: [...burstResults, soakResult]
  };

  await writeFile(RESULT_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[load-test] Results written to ${RESULT_PATH}`);
  console.log(JSON.stringify(output, null, 2));
} finally {
  if (mockServer) {
    await new Promise((resolve, reject) => {
      mockServer.close((err) => {
        if (err) reject(err);
        else resolve(undefined);
      });
    });
  }
}
