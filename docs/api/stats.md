# Stats

Query server runtime statistics — active connections, held locks, semaphores, and idle entries.

## `stats(options?)`

Opens a short-lived connection, sends the `stats` command, and returns the parsed response.

```ts
import { stats } from "dflockd-client";

const s = await stats();
console.log(`connections: ${s.connections}`);
console.log(`locks held: ${s.locks.length}`);
console.log(`semaphores active: ${s.semaphores.length}`);
```

### Options

| Option | Type                    | Default       | Description                    |
|--------|-------------------------|---------------|--------------------------------|
| `host` | `string`                | `127.0.0.1`   | Server host                    |
| `port` | `number`                | `6388`        | Server port                    |
| `tls`  | `tls.ConnectionOptions` | `undefined`   | TLS options                    |
| `auth` | `string`                | `undefined`   | Auth token                     |
| `connectTimeoutMs` | `number`       | `undefined`   | TCP connect timeout in milliseconds |

### Query a specific server

```ts
const s = await stats({ host: "10.0.0.1", port: 6388 });
```

### With TLS and auth

```ts
const s = await stats({
  host: "10.0.0.1",
  port: 6388,
  tls: {},
  auth: "my-secret-token",
});
```

## Response types

### `Stats`

```ts
interface Stats {
  connections: number;
  locks: StatsLock[];
  semaphores: StatsSemaphore[];
  idle_locks: StatsIdleLock[];
  idle_semaphores: StatsIdleSemaphore[];
}
```

### `StatsLock`

```ts
interface StatsLock {
  key: string;
  owner_conn_id: number;
  lease_expires_in_s: number;
  waiters: number;
}
```

### `StatsSemaphore`

```ts
interface StatsSemaphore {
  key: string;
  limit: number;
  holders: number;
  waiters: number;
}
```

### `StatsIdleLock` / `StatsIdleSemaphore`

```ts
interface StatsIdleLock {
  key: string;
  idle_s: number;
}

interface StatsIdleSemaphore {
  key: string;
  idle_s: number;
}
```

## Inspecting lock and semaphore details

```ts
const s = await stats();

for (const lock of s.locks) {
  console.log(
    `  ${lock.key} owner=${lock.owner_conn_id} expires_in=${lock.lease_expires_in_s}s waiters=${lock.waiters}`
  );
}

for (const sem of s.semaphores) {
  console.log(
    `  ${sem.key} holders=${sem.holders}/${sem.limit} waiters=${sem.waiters}`
  );
}
```
