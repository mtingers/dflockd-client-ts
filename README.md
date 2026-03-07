# dflockd-client

TypeScript client for the [dflockd](https://github.com/mtingers/dflockd) distributed lock daemon.

**[Documentation](https://mtingers.github.io/dflockd-client-ts/)**

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
| `acquireTimeoutS`  | `number`                      | `10`                     | Seconds to wait for the lock before giving up (integer ≥ 0) |
| `leaseTtlS`        | `number`                      | server default           | Server-side lease duration in seconds (integer ≥ 1) |
| `servers`          | `Array<[string, number]>`     | `[["127.0.0.1", 6388]]` | List of `[host, port]` pairs                     |
| `shardingStrategy` | `ShardingStrategy`            | `stableHashShard`        | Function mapping `(key, numServers)` to a server index |
| `host`             | `string`                      | `127.0.0.1`              | Server host *(deprecated — use `servers`)*       |
| `port`             | `number`                      | `6388`                   | Server port *(deprecated — use `servers`)*       |
| `renewRatio`       | `number`                      | `0.5`                    | Renew at `lease * ratio` seconds (e.g. 50% of TTL)|
| `tls`              | `tls.ConnectionOptions`       | `undefined`              | TLS options; pass `{}` for default system CA       |
| `auth`             | `string`                      | `undefined`              | Auth token for servers started with `--auth-token` |
| `onLockLost`       | `(key: string, token: string) => void` | `undefined`     | Called when background lease renewal fails and the lock is lost |
| `connectTimeoutMs` | `number`                      | `undefined`              | TCP connect timeout in milliseconds               |
| `socketTimeoutMs`  | `number`                      | `undefined`              | Socket idle timeout in milliseconds               |

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
| `limit`            | `number`                      | *(required)*             | Max concurrent holders (integer ≥ 1)             |
| `acquireTimeoutS`  | `number`                      | `10`                     | Seconds to wait before giving up (integer ≥ 0)   |
| `leaseTtlS`        | `number`                      | server default           | Server-side lease duration in seconds (integer ≥ 1) |
| `servers`          | `Array<[string, number]>`     | `[["127.0.0.1", 6388]]` | List of `[host, port]` pairs                     |
| `shardingStrategy` | `ShardingStrategy`            | `stableHashShard`        | Function mapping `(key, numServers)` to a server index |
| `host`             | `string`                      | `127.0.0.1`              | Server host *(deprecated — use `servers`)*       |
| `port`             | `number`                      | `6388`                   | Server port *(deprecated — use `servers`)*       |
| `renewRatio`       | `number`                      | `0.5`                    | Renew at `lease * ratio` seconds (e.g. 50% of TTL)|
| `tls`              | `tls.ConnectionOptions`       | `undefined`              | TLS options; pass `{}` for default system CA       |
| `auth`             | `string`                      | `undefined`              | Auth token for servers started with `--auth-token` |
| `onLockLost`       | `(key: string, token: string) => void` | `undefined`     | Called when background lease renewal fails and the slot is lost |
| `connectTimeoutMs` | `number`                      | `undefined`              | TCP connect timeout in milliseconds               |
| `socketTimeoutMs`  | `number`                      | `undefined`              | Socket idle timeout in milliseconds               |

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

## TLS

When the dflockd server is started with `--tls-cert` and `--tls-key`, all
connections must use TLS. Pass a `tls` option (accepting Node's
`tls.ConnectionOptions`) to enable TLS on the client:

```ts
import { DistributedLock, DistributedSemaphore, stats } from "dflockd-client";

// TLS with default system CA validation
const lock = new DistributedLock({ key: "my-resource", tls: {} });

// Self-signed CA
import * as fs from "fs";
const lock2 = new DistributedLock({
  key: "my-resource",
  tls: { ca: fs.readFileSync("ca.pem") },
});

// Semaphore over TLS
const sem = new DistributedSemaphore({ key: "my-resource", limit: 5, tls: {} });

// Stats over TLS
const s = await stats({ host: "10.0.0.1", port: 6388, tls: {} });
```

## Authentication

When the dflockd server is started with `--auth-token`, every connection must
authenticate before sending any other command. Pass the `auth` option to enable
token-based authentication:

```ts
import { DistributedLock, DistributedSemaphore, stats } from "dflockd-client";

// Lock with auth
const lock = new DistributedLock({ key: "my-resource", auth: "my-secret-token" });

// Semaphore with auth
const sem = new DistributedSemaphore({ key: "my-resource", limit: 5, auth: "my-secret-token" });

// Stats with auth
const s = await stats({ host: "10.0.0.1", port: 6388, auth: "my-secret-token" });

// Combined with TLS
const secureLock = new DistributedLock({
  key: "my-resource",
  tls: {},
  auth: "my-secret-token",
});
```

If authentication fails, an `AuthError` (a subclass of `LockError`) is thrown.

### Error handling

```ts
import { DistributedLock, AcquireTimeoutError, AuthError, LockError } from "dflockd-client";

try {
  await lock.withLock(async () => { /* ... */ });
} catch (err) {
  if (err instanceof AcquireTimeoutError) {
    // lock could not be acquired within acquireTimeoutS
  } else if (err instanceof AuthError) {
    // authentication failed (bad or missing token)
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
  publish, stats,
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

// Signal — publish only (no subscription on raw sockets)
const delivered = await publish(sock, "events.user.login", '{"user":"alice"}');

sock.destroy();
```

## Signals

Publish/subscribe messaging with NATS-style pattern matching and optional
queue groups for load-balanced consumption.

### `SignalConnection` (recommended)

```ts
import { SignalConnection } from "dflockd-client";

const conn = await SignalConnection.connect();

// Subscribe to signals
conn.onSignal((sig) => {
  console.log(`${sig.channel}: ${sig.payload}`);
});

await conn.listen("events.>");

// ... later
await conn.unlisten("events.>");
conn.close();
```

### Publish a signal

```ts
import { SignalConnection } from "dflockd-client";

const conn = await SignalConnection.connect();
const delivered = await conn.emit("events.user.login", '{"user":"alice"}');
console.log(`delivered to ${delivered} listener(s)`);
conn.close();
```

### Pattern matching

Subscription patterns support NATS-style wildcards:

- `*` matches exactly one dot-separated token (`events.*.login` matches
  `events.user.login` but not `events.user.admin.login`)
- `>` matches one or more trailing tokens (`events.>` matches
  `events.user.login` and `events.order.created`)

Publishing always uses literal channel names (no wildcards).

### Queue groups

Listeners can join a named queue group. Within a group, each signal is
delivered to exactly one member (round-robin), enabling load-balanced
processing. Non-grouped listeners always receive every matching signal.

```ts
// Worker 1
await conn.listen("tasks.>", "workers");

// Worker 2 (same group — only one receives each signal)
await conn2.listen("tasks.>", "workers");
```

### Async iterator

`SignalConnection` implements `Symbol.asyncIterator`, so you can consume
signals with a `for-await-of` loop:

```ts
const conn = await SignalConnection.connect();
await conn.listen("events.>");

for await (const sig of conn) {
  console.log(sig.channel, sig.payload);
}
// Loop ends when conn.close() is called
```

### Signal connection options

| Option             | Type                    | Default        | Description                         |
|--------------------|-------------------------|----------------|-------------------------------------|
| `host`             | `string`                | `127.0.0.1`    | Server host                         |
| `port`             | `number`                | `6388`         | Server port                         |
| `tls`              | `tls.ConnectionOptions` | `undefined`    | TLS options; pass `{}` for system CA|
| `auth`             | `string`                | `undefined`    | Auth token                          |
| `connectTimeoutMs` | `number`                | `undefined`    | TCP connect timeout in milliseconds |

## License

MIT
