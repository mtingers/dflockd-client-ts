# Sharding

Distribute locks across multiple dflockd instances. Each key is consistently routed to the same server using CRC32-based hashing (matching Python's `zlib.crc32`).

## Multi-server setup

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
  // routed to a consistent server based on key
});
```

The same sharding works with `DistributedSemaphore`:

```ts
import { DistributedSemaphore } from "dflockd-client";

const sem = new DistributedSemaphore({
  key: "worker-pool",
  limit: 5,
  servers: [
    ["10.0.0.1", 6388],
    ["10.0.0.2", 6388],
  ],
});
```

## Default strategy: `stableHashShard`

The default `stableHashShard` function uses CRC32 (IEEE) to deterministically map keys to servers. It is compatible with the Python client's `stable_hash_shard`, so both clients route the same key to the same server.

```ts
import { stableHashShard } from "dflockd-client";

const idx = stableHashShard("my-key", 3); // 0, 1, or 2
```

## Custom sharding strategy

Supply a custom function matching the `ShardingStrategy` type:

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

The type signature:

```ts
type ShardingStrategy = (key: string, numServers: number) => number;
```
