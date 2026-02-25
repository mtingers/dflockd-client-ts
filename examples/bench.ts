/**
 * Benchmark: N concurrent workers each acquire/release a shared lock
 * repeatedly and report latency statistics.
 *
 * Usage:
 *     npx tsx examples/bench.ts [--workers 10] [--rounds 50] [--key bench] \
 *         [--servers host1:port1,host2:port2]
 */

import { parseArgs } from "node:util";
import { DistributedLock } from "dflockd-client";

function parseServers(raw: string): Array<[string, number]> {
  return raw.split(",").map((entry) => {
    const i = entry.lastIndexOf(":");
    return [entry.slice(0, i), Number(entry.slice(i + 1))];
  });
}

function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length & 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const sumSq = values.reduce((s, v) => s + (v - mean) ** 2, 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

async function worker(
  key: string,
  rounds: number,
  timeoutS: number,
  servers: Array<[string, number]>,
): Promise<number[]> {
  const latencies: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const lock = new DistributedLock({
      key,
      acquireTimeoutS: timeoutS,
      leaseTtlS: 10,
      servers,
    });
    const t0 = performance.now();
    await lock.withLock(async () => {
      // acquire + immediate release
    });
    latencies.push((performance.now() - t0) / 1000); // seconds
  }
  return latencies;
}

async function run(
  workers: number,
  rounds: number,
  key: string,
  timeoutS: number,
  servers: Array<[string, number]>,
): Promise<void> {
  console.log(
    `bench: ${workers} workers x ${rounds} rounds (key_prefix=${JSON.stringify(key)})`,
  );
  console.log();

  const tStart = performance.now();
  const results = await Promise.all(
    Array.from({ length: workers }, () => {
      const k = `${key}_${Math.floor(100000 + Math.random() * 9900000)}`;
      return worker(k, rounds, timeoutS, servers);
    }),
  );
  const wall = (performance.now() - tStart) / 1000;

  const all: number[] = results.flat();
  all.sort((a, b) => a - b);

  const totalOps = all.length;
  const mean = all.reduce((s, v) => s + v, 0) / totalOps;
  const mn = all[0];
  const mx = all[all.length - 1];
  const p50 = median(all);
  const sd = stdev(all, mean);

  console.log(`  total ops : ${totalOps}`);
  console.log(`  wall time : ${wall.toFixed(3)}s`);
  console.log(`  throughput: ${(totalOps / wall).toFixed(1)} ops/s`);
  console.log();
  console.log(`  mean      : ${(mean * 1000).toFixed(3)} ms`);
  console.log(`  min       : ${(mn * 1000).toFixed(3)} ms`);
  console.log(`  max       : ${(mx * 1000).toFixed(3)} ms`);
  console.log(`  p50       : ${(p50 * 1000).toFixed(3)} ms`);
  console.log(`  stdev     : ${(sd * 1000).toFixed(3)} ms`);
}

const { values } = parseArgs({
  options: {
    workers: { type: "string", default: "10" },
    rounds: { type: "string", default: "50" },
    key: { type: "string", default: "bench" },
    timeout: { type: "string", default: "30" },
    servers: { type: "string", default: "127.0.0.1:6388" },
  },
  strict: true,
});

await run(
  Number(values.workers),
  Number(values.rounds),
  values.key!,
  Number(values.timeout),
  parseServers(values.servers!),
);
