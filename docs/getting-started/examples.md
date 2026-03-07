# Examples

## Locks

### Basic lock and release

```ts
import { DistributedLock } from "dflockd-client";

const lock = new DistributedLock({
  key: "my-key",
  acquireTimeoutS: 10,
  leaseTtlS: 20,
});

await lock.acquire();
console.log(`acquired key=${lock.key} token=${lock.token} lease=${lock.lease}`);

// lock auto-renews in the background
// ... do work ...

await lock.release();
```

### `withLock` helper

```ts
const lock = new DistributedLock({
  key: "my-key",
  acquireTimeoutS: 10,
  leaseTtlS: 20,
});

await lock.withLock(async () => {
  console.log(`acquired key=${lock.key} token=${lock.token}`);
  // ... do work ...
});
// lock released automatically
```

### FIFO ordering — concurrent workers

Multiple workers competing for the same lock are granted access in FIFO order:

```ts
async function worker(id: number): Promise<void> {
  const lock = new DistributedLock({
    key: "shared-key",
    acquireTimeoutS: 30,
  });

  await lock.withLock(async () => {
    console.log(`worker ${id}: acquired`);
    await new Promise((r) => setTimeout(r, 100));
    console.log(`worker ${id}: releasing`);
  });
}

// Launch 5 workers — they acquire the lock in order
await Promise.all(Array.from({ length: 5 }, (_, i) => worker(i)));
```

### Two-phase locking (enqueue / wait)

Split acquisition into two steps to notify an external system between joining the queue and blocking:

```ts
const lock = new DistributedLock({
  key: "two-phase-key",
  acquireTimeoutS: 10,
  leaseTtlS: 20,
});

// Step 1: join the queue (returns immediately)
const status = await lock.enqueue(); // "acquired" or "queued"

// Step 2: notify external system
console.log(`enqueue status: ${status}`);
notifyExternalSystem(status);

// Step 3: block until the lock is granted
const granted = await lock.wait(10);
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

## Semaphores

### Concurrent access

Allow up to N concurrent holders per key:

```ts
import { DistributedSemaphore } from "dflockd-client";

const sem = new DistributedSemaphore({ key: "worker-pool", limit: 5 });

await sem.withLock(async () => {
  // up to 5 concurrent holders
  console.log("doing work...");
});
```

## Configuration

### Multi-server sharding

Distribute locks across multiple dflockd instances:

```ts
const lock = new DistributedLock({
  key: "my-resource",
  servers: [
    ["10.0.0.1", 6388],
    ["10.0.0.2", 6388],
    ["10.0.0.3", 6388],
  ],
});

await lock.withLock(async () => {
  // routed to a consistent server based on key
});
```

### TLS

```ts
const lock = new DistributedLock({
  key: "my-resource",
  tls: {}, // uses system CA
});

// Or with a custom CA:
import * as fs from "fs";
const lock2 = new DistributedLock({
  key: "my-resource",
  tls: { ca: fs.readFileSync("ca.pem") },
});
```

### Authentication

```ts
const lock = new DistributedLock({
  key: "my-resource",
  auth: "my-secret-token",
});
```

## Signals

### Pub/sub with pattern matching

Publish and subscribe to signals with pattern matching:

```ts
import { SignalConnection } from "dflockd-client";

const conn = await SignalConnection.connect();

// Subscribe to all events under "events.>"
await conn.listen("events.>");

conn.onSignal((sig) => {
  console.log(`${sig.channel}: ${sig.payload}`);
});

// Publish a signal
await conn.emit("events.user.created", "user-123");
```

### Queue groups

Distribute signals across workers so each signal is handled by exactly one member:

```ts
import { SignalConnection } from "dflockd-client";

const worker = await SignalConnection.connect();
await worker.listen("tasks.>", "my-worker-group");

for await (const sig of worker) {
  console.log(`processing ${sig.payload}`);
}
```

## Error handling

```ts
import {
  DistributedLock,
  AcquireTimeoutError,
  AuthError,
  LockError,
} from "dflockd-client";

try {
  await lock.withLock(async () => { /* ... */ });
} catch (err) {
  if (err instanceof AcquireTimeoutError) {
    // lock could not be acquired within acquireTimeoutS
  } else if (err instanceof AuthError) {
    // authentication failed (bad or missing token)
  } else if (err instanceof LockError) {
    // protocol-level error (server disconnect, etc.)
  }
}
```
