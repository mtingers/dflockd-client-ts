# DistributedSemaphore

A semaphore allows up to N concurrent holders per key (instead of exactly 1 for a lock). The `DistributedSemaphore` API mirrors `DistributedLock`.

## Constructor

```ts
import { DistributedSemaphore } from "dflockd-client";

const sem = new DistributedSemaphore({
  key: "worker-pool",
  limit: 5,
  acquireTimeoutS: 10,
  leaseTtlS: 20,
});
```

### Options

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
| `tls`              | `tls.ConnectionOptions`       | `undefined`              | TLS options; pass `{}` for default system CA       |
| `auth`             | `string`                      | `undefined`              | Auth token for servers started with `--auth-token` |
| `onLockLost`       | `(key: string, token: string) => void` | `undefined`     | Called when background lease renewal fails and the slot is lost; the connection is automatically closed afterwards |
| `connectTimeoutMs` | `number`                      | `undefined`              | TCP connect timeout in milliseconds; `undefined` means no timeout |
| `socketTimeoutMs`  | `number`                      | `undefined`              | Socket idle timeout in milliseconds; destroys the socket if no data is received within this period |

## Methods

### `withLock<T>(fn: () => T | Promise<T>): Promise<T>`

Acquire a semaphore slot, run `fn`, then release — even if `fn` throws.

```ts
await sem.withLock(async () => {
  // critical section — up to 5 concurrent holders
});
```

### `acquire(opts?: { force?: boolean }): Promise<boolean>`

Acquire a semaphore slot. Returns `true` on success, `false` on timeout.

Throws `LockError` if the instance is already connected (call `release()` or `close()` first). Pass `{ force: true }` to silently close the existing connection before acquiring.

```ts
const ok = await sem.acquire();
```

### `release(): Promise<void>`

Release the semaphore slot and close the connection.

Throws `LockError` if the instance is already closed (e.g. after a previous `release()` or `close()` call).

```ts
await sem.release();
```

### `enqueue(opts?: { force?: boolean }): Promise<"acquired" | "queued">`

Two-phase step 1: connect and join the FIFO queue. Returns `"acquired"` if a slot was immediately available or `"queued"` if all slots are taken.

Throws `LockError` if already connected. Pass `{ force: true }` to close first.

### `wait(timeoutS?: number): Promise<boolean>`

Two-phase step 2: block until a semaphore slot is granted. Returns `true` if granted, `false` on timeout.

### `close(): void`

Close the underlying socket without releasing. Idempotent.

## Properties

| Property | Type              | Description                              |
|----------|-------------------|------------------------------------------|
| `key`    | `string`          | The semaphore key name                   |
| `limit`  | `number`          | Maximum concurrent holders               |
| `token`  | `string \| null`  | The current slot token, or `null`        |
| `lease`  | `number`          | The lease TTL in seconds from last acquire |
