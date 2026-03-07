# dflockd-client

TypeScript client for the [dflockd](https://github.com/mtingers/dflockd) distributed lock daemon.

## Features

- **Locks and semaphores** with automatic lease renewal
- **Two-phase locking** — enqueue then wait, with hooks between steps
- **Signal pub/sub** — NATS-style pattern matching and queue groups
- **Multi-server sharding** — CRC32-based consistent hashing
- **TLS and authentication** support
- **Low-level API** for direct socket control

## Quick example

```ts
import { DistributedLock } from "dflockd-client";

const lock = new DistributedLock({ key: "my-resource" });

await lock.withLock(async () => {
  // critical section — lock is held here
});
// lock is released
```

## Next steps

- [Getting Started](getting-started/index.md) — install and acquire your first lock
- [API Reference](api/lock.md) — `DistributedLock`, `DistributedSemaphore`, `SignalConnection`
- [Guides](guides/security.md) — TLS, authentication, sharding
