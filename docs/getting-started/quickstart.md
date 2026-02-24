# Quick Start

## 1. Start the server

```bash
dflockd
```

The server listens on `127.0.0.1:6388` by default. See the [dflockd docs](https://github.com/mtingers/dflockd) for configuration options.

## 2. Install the client

```bash
npm install dflockd-client
```

## 3. Use `withLock` (recommended)

The simplest way to use a lock. Acquires, runs your callback, and releases automatically — even if the callback throws.

```ts
import { DistributedLock } from "dflockd-client";

const lock = new DistributedLock({ key: "my-resource" });

await lock.withLock(async () => {
  // critical section — lock is held here
  console.log("doing work...");
});
// lock is released
```

## 4. Manual acquire / release

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

## What happens under the hood

1. The client opens a TCP connection to the dflockd server.
2. It sends a lock request with the key and timeout.
3. The server grants the lock immediately if it's free, or enqueues the client in FIFO order.
4. Once acquired, the client automatically renews the lease in the background.
5. On release, the connection is closed and the server grants the lock to the next FIFO waiter.
