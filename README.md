# dflockd-client

TypeScript client for the [dflockd](https://github.com/mtingers/dflockd) distributed lock daemon.

## Installation

```bash
npm install dflockd-client
```

## Usage

Start the [dflockd](https://github.com/mtingers/dflockd) server:

```bash
dflockd
```

### `withLock` (recommended)

The simplest way to use a lock. Acquires, runs your callback, and releases
automatically — even if the callback throws.

```ts
import { DistributedLock } from "dflockd-client";

const lock = new DistributedLock({ key: "my-resource" });

await lock.withLock(async () => {
  // critical section — lock is held here
});
// lock is released
```

### Manual `acquire` / `release`

```ts
import { DistributedLock } from "dflockd-client";

const lock = new DistributedLock({
  key: "my-resource",
  acquireTimeoutS: 10, // wait up to 10 s (default)
  leaseTtlS: 20,       // server-side lease duration
});

const ok = await lock.acquire(); // true on success, false on timeout
if (!ok) {
  console.error("could not acquire lock");
  process.exit(1);
}

try {
  // critical section — lock is held and auto-renewed
} finally {
  await lock.release();
}
```

### Two-phase lock (enqueue / wait)

Split acquisition into two steps so you can notify an external system
(webhook, database, queue) between joining the FIFO queue and blocking.

```ts
import { DistributedLock } from "dflockd-client";

const lock = new DistributedLock({
  key: "my-resource",
  acquireTimeoutS: 10,
  leaseTtlS: 20,
});

// Step 1: join the queue (non-blocking, returns immediately)
const status = await lock.enqueue(); // "acquired" or "queued"

// Step 2: do something between enqueue and blocking
console.log(`enqueue status: ${status}`);
notifyExternalSystem(status);

// Step 3: block until the lock is granted (or timeout)
const granted = await lock.wait(10); // true on success, false on timeout
if (!granted) {
  console.error("timed out waiting for lock");
  process.exit(1);
}

try {
  // critical section — lock is held and auto-renewed
} finally {
  await lock.release();
}
```

If the lock is free when `enqueue()` is called, it returns `"acquired"` and
the lock is already held (fast path). `wait()` then returns `true` immediately
without blocking. If the lock is contended, `enqueue()` returns `"queued"` and
`wait()` blocks until the lock is granted or the timeout expires.

### Options

| Option             | Type                          | Default                  | Description                                      |
|--------------------|-------------------------------|--------------------------|--------------------------------------------------|
| `key`              | `string`                      | *(required)*             | Lock name                                        |
| `acquireTimeoutS`  | `number`                      | `10`                     | Seconds to wait for the lock before giving up    |
| `leaseTtlS`        | `number`                      | server default           | Server-side lease duration in seconds             |
| `servers`          | `Array<[string, number]>`     | `[["127.0.0.1", 6388]]` | List of `[host, port]` pairs                     |
| `shardingStrategy` | `ShardingStrategy`            | `stableHashShard`        | Function mapping `(key, numServers)` to a server index |
| `host`             | `string`                      | `127.0.0.1`              | Server host *(deprecated — use `servers`)*       |
| `port`             | `number`                      | `6388`                   | Server port *(deprecated — use `servers`)*       |
| `renewRatio`       | `number`                      | `0.5`                    | Renew at `lease * ratio` seconds (e.g. 50% of TTL)|

### Multi-server sharding

Distribute locks across multiple dflockd instances. Each key is consistently
routed to the same server using CRC32-based hashing (matching Python's
`zlib.crc32`).

```ts
import { DistributedLock } from "dflockd-client";

const lock = new DistributedLock({
  key: "my-resource",
  servers: [
    ["10.0.0.1", 6388],
    ["10.0.0.2", 6388],
    ["10.0.0.3", 6388],
  ],
});

await lock.withLock(async () => {
  // critical section — routed to a consistent server based on key
});
```

You can supply a custom sharding strategy:

```ts
import { DistributedLock, ShardingStrategy } from "dflockd-client";

const roundRobin: ShardingStrategy = (_key, numServers) => {
  return Math.floor(Math.random() * numServers);
};

const lock = new DistributedLock({
  key: "my-resource",
  servers: [
    ["10.0.0.1", 6388],
    ["10.0.0.2", 6388],
  ],
  shardingStrategy: roundRobin,
});
```

## Semaphore

A semaphore allows up to N concurrent holders per key (instead of exactly 1
for a lock). The `DistributedSemaphore` API mirrors `DistributedLock`.

### `withLock` (recommended)

```ts
import { DistributedSemaphore } from "dflockd-client";

const sem = new DistributedSemaphore({ key: "my-resource", limit: 5 });

await sem.withLock(async () => {
  // critical section — up to 5 concurrent holders
});
// slot is released
```

### Manual `acquire` / `release`

```ts
import { DistributedSemaphore } from "dflockd-client";

const sem = new DistributedSemaphore({
  key: "my-resource",
  limit: 5,
  acquireTimeoutS: 10,
  leaseTtlS: 20,
});

const ok = await sem.acquire(); // true on success, false on timeout
if (!ok) {
  console.error("could not acquire semaphore slot");
  process.exit(1);
}

try {
  // critical section — slot is held and auto-renewed
} finally {
  await sem.release();
}
```

### Two-phase semaphore (enqueue / wait)

```ts
import { DistributedSemaphore } from "dflockd-client";

const sem = new DistributedSemaphore({
  key: "my-resource",
  limit: 5,
  acquireTimeoutS: 10,
});

const status = await sem.enqueue(); // "acquired" or "queued"
console.log(`enqueue status: ${status}`);

const granted = await sem.wait(10); // true on success, false on timeout
if (!granted) {
  console.error("timed out waiting for semaphore slot");
  process.exit(1);
}

try {
  // critical section — slot is held and auto-renewed
} finally {
  await sem.release();
}
```

### Semaphore options

| Option             | Type                          | Default                  | Description                                      |
|--------------------|-------------------------------|--------------------------|--------------------------------------------------|
| `key`              | `string`                      | *(required)*             | Semaphore name                                   |
| `limit`            | `number`                      | *(required)*             | Max concurrent holders                           |
| `acquireTimeoutS`  | `number`                      | `10`                     | Seconds to wait before giving up                 |
| `leaseTtlS`        | `number`                      | server default           | Server-side lease duration in seconds             |
| `servers`          | `Array<[string, number]>`     | `[["127.0.0.1", 6388]]` | List of `[host, port]` pairs                     |
| `shardingStrategy` | `ShardingStrategy`            | `stableHashShard`        | Function mapping `(key, numServers)` to a server index |
| `host`             | `string`                      | `127.0.0.1`              | Server host *(deprecated — use `servers`)*       |
| `port`             | `number`                      | `6388`                   | Server port *(deprecated — use `servers`)*       |
| `renewRatio`       | `number`                      | `0.5`                    | Renew at `lease * ratio` seconds (e.g. 50% of TTL)|

## Stats

Query server runtime statistics (active connections, held locks, semaphores,
idle entries).

```ts
import { stats } from "dflockd-client";

const s = await stats();
console.log(`connections: ${s.connections}`);
console.log(`locks held: ${s.locks.length}`);
console.log(`semaphores active: ${s.semaphores.length}`);

for (const lock of s.locks) {
  console.log(`  ${lock.key} owner=${lock.owner_conn_id} expires_in=${lock.lease_expires_in_s}s waiters=${lock.waiters}`);
}

for (const sem of s.semaphores) {
  console.log(`  ${sem.key} holders=${sem.holders}/${sem.limit} waiters=${sem.waiters}`);
}
```

Pass `{ host, port }` to query a specific server:

```ts
const s = await stats({ host: "10.0.0.1", port: 6388 });
```

### Error handling

```ts
import { DistributedLock, AcquireTimeoutError, LockError } from "dflockd-client";

try {
  await lock.withLock(async () => { /* ... */ });
} catch (err) {
  if (err instanceof AcquireTimeoutError) {
    // lock could not be acquired within acquireTimeoutS
  } else if (err instanceof LockError) {
    // protocol-level error (bad token, server disconnect, etc.)
  }
}
```

### Low-level functions

For cases where you manage the socket yourself:

```ts
import * as net from "net";
import {
  acquire, enqueue, waitForLock, renew, release,
  semAcquire, semEnqueue, semWaitForLock, semRenew, semRelease,
  stats,
} from "dflockd-client";

const sock = net.createConnection({ host: "127.0.0.1", port: 6388 });

// Lock — single-phase
const { token, lease } = await acquire(sock, "my-key", 10);
const remaining = await renew(sock, "my-key", token, 60);
await release(sock, "my-key", token);

// Lock — two-phase
const result = await enqueue(sock, "another-key");   // { status, token, lease }
if (result.status === "queued") {
  const granted = await waitForLock(sock, "another-key", 10); // { token, lease }
}

// Semaphore — single-phase (limit = 5)
const sem = await semAcquire(sock, "sem-key", 10, 5); // { token, lease }
const semRemaining = await semRenew(sock, "sem-key", sem.token, 60);
await semRelease(sock, "sem-key", sem.token);

// Semaphore — two-phase
const semResult = await semEnqueue(sock, "sem-key", 5); // { status, token, lease }
if (semResult.status === "queued") {
  const semGranted = await semWaitForLock(sock, "sem-key", 10); // { token, lease }
}

sock.destroy();
```

## License

MIT
