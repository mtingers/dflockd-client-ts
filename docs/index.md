# dflockd-client (TypeScript)

TypeScript client for the [dflockd](https://github.com/mtingers/dflockd) distributed lock daemon.

## Features

- **`withLock` helper** — acquire, run callback, release automatically (even on errors)
- **Two-phase locking** — split enqueue and wait to notify external systems between queue join and blocking
- **Automatic lease renewal** — background renewal keeps locks alive while your code runs
- **Distributed semaphores** — allow up to N concurrent holders per key
- **Signal pub/sub** — publish and subscribe to signals with NATS-style pattern matching and queue groups
- **Multi-server sharding** — CRC32-based consistent hashing across multiple dflockd instances
- **TLS and authentication** — encrypted connections and token-based auth
- **Low-level API** — protocol functions for fine-grained socket control

## Quick example

```ts
import { DistributedLock } from "dflockd-client";

const lock = new DistributedLock({ key: "my-resource" });

await lock.withLock(async () => {
  // critical section — lock is held here
});
// lock is released
```

## Getting started

- [Installation](getting-started/installation.md) — install via npm
- [Quick Start](getting-started/quickstart.md) — acquire your first lock in under a minute
- [Examples](getting-started/examples.md) — common usage patterns
- [API Reference](api/lock.md) — full `DistributedLock`, `DistributedSemaphore`, and `SignalConnection` API
