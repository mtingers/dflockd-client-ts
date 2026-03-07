# Getting Started

## Requirements

- Node.js 16+
- A running [dflockd](https://github.com/mtingers/dflockd) server

## Install

```bash
npm install dflockd-client
```

## Start the server

```bash
dflockd
```

The server listens on `127.0.0.1:6388` by default. See the [dflockd docs](https://github.com/mtingers/dflockd) for configuration options.

## `withLock` (recommended)

Acquires, runs your callback, and releases automatically — even if the callback throws.

```ts
import { DistributedLock } from "dflockd-client";

const lock = new DistributedLock({ key: "my-resource" });

await lock.withLock(async () => {
  // critical section — lock is held here
});
// lock is released
```

## Manual acquire / release

For more control over the lock lifecycle:

```ts
import { DistributedLock } from "dflockd-client";

const lock = new DistributedLock({
  key: "my-resource",
  acquireTimeoutS: 10,
  leaseTtlS: 20,
});

const ok = await lock.acquire();
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

## Two-phase locking (enqueue / wait)

Split acquisition into two steps to notify an external system between joining the queue and blocking:

```ts
const lock = new DistributedLock({
  key: "my-resource",
  acquireTimeoutS: 10,
  leaseTtlS: 20,
});

// Step 1: join the queue (returns immediately)
const status = await lock.enqueue(); // "acquired" or "queued"

// Step 2: do something between enqueue and blocking
console.log(`enqueue status: ${status}`);

// Step 3: block until the lock is granted
const granted = await lock.wait(10);
if (!granted) {
  console.error("timed out waiting for lock");
  process.exit(1);
}

try {
  // critical section
} finally {
  await lock.release();
}
```

## What happens under the hood

1. The client opens a TCP connection to the dflockd server.
2. It sends a lock request with the key and timeout.
3. The server grants the lock immediately if it's free, or enqueues the client in FIFO order.
4. Once acquired, the client automatically renews the lease in the background.
5. On release, the connection is closed and the server grants the lock to the next FIFO waiter.
