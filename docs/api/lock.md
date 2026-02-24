# DistributedLock

The `DistributedLock` class manages the full lifecycle: connecting to the correct shard, acquiring the lock, renewing the lease in the background, and releasing on cleanup.

## Constructor

```ts
import { DistributedLock } from "dflockd-client";

const lock = new DistributedLock({
  key: "my-resource",
  acquireTimeoutS: 10,
  leaseTtlS: 20,
  servers: [["127.0.0.1", 6388]],
});
```

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
| `tls`              | `tls.ConnectionOptions`       | `undefined`              | TLS options; pass `{}` for default system CA       |
| `auth`             | `string`                      | `undefined`              | Auth token for servers started with `--auth-token` |
| `onLockLost`       | `(key: string, token: string) => void` | `undefined`     | Called when background lease renewal fails and the lock is lost |

## Methods

### `withLock<T>(fn: () => T | Promise<T>): Promise<T>`

Acquire the lock, run `fn`, then release — even if `fn` throws. This is the recommended way to use the lock.

```ts
await lock.withLock(async () => {
  // critical section
});
```

Throws `AcquireTimeoutError` if the lock cannot be acquired within `acquireTimeoutS`.

### `acquire(): Promise<boolean>`

Acquire the lock. Returns `true` on success, `false` on timeout.

```ts
const ok = await lock.acquire();
if (!ok) {
  console.error("timed out");
}
```

### `release(): Promise<void>`

Release the lock and close the connection. Stops background lease renewal.

```ts
await lock.release();
```

### `enqueue(): Promise<"acquired" | "queued">`

Two-phase step 1: connect and join the FIFO queue. Returns `"acquired"` if the lock was free (fast path) or `"queued"` if contended.

If acquired immediately, the background renew loop starts automatically.

```ts
const status = await lock.enqueue();
console.log(status); // "acquired" or "queued"
```

### `wait(timeoutS?: number): Promise<boolean>`

Two-phase step 2: block until the lock is granted. Returns `true` if granted, `false` on timeout. If already acquired during `enqueue()`, returns `true` immediately.

```ts
const granted = await lock.wait(10);
```

### `close(): Promise<void>`

Close the underlying socket without sending a release command. The server will auto-release the lock when the lease expires. Idempotent.

## Properties

| Property | Type              | Description                              |
|----------|-------------------|------------------------------------------|
| `key`    | `string`          | The lock key name                        |
| `token`  | `string \| null`  | The current lock token, or `null`        |
| `lease`  | `number`          | The lease TTL in seconds from last acquire |
