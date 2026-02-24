# Low-level Functions

For cases where you manage the socket yourself, the package exports protocol-level functions that map directly to dflockd wire commands.

## Lock functions

### `acquire(sock, key, acquireTimeoutS, leaseTtlS?)`

Send a lock request. Resolves with `{ token, lease }` on success. Throws `AcquireTimeoutError` on timeout.

```ts
import * as net from "net";
import { acquire, release, renew } from "dflockd-client";

const sock = net.createConnection({ host: "127.0.0.1", port: 6388 });

const { token, lease } = await acquire(sock, "my-key", 10);
console.log(`acquired: token=${token} lease=${lease}s`);
```

### `renew(sock, key, token, leaseTtlS?)`

Renew the lease on a held lock. Returns the remaining lease time in seconds.

```ts
const remaining = await renew(sock, "my-key", token, 60);
```

### `release(sock, key, token)`

Release a held lock.

```ts
await release(sock, "my-key", token);
```

### `enqueue(sock, key, leaseTtlS?)`

Two-phase step 1: join the FIFO queue. Returns `{ status, token, lease }`.

- If `status` is `"acquired"`, the lock is already held and `token`/`lease` are set.
- If `status` is `"queued"`, `token` and `lease` are `null`.

```ts
import { enqueue, waitForLock } from "dflockd-client";

const result = await enqueue(sock, "my-key");
if (result.status === "queued") {
  const granted = await waitForLock(sock, "my-key", 10);
  console.log(`granted: token=${granted.token}`);
}
```

### `waitForLock(sock, key, waitTimeoutS)`

Two-phase step 2: block until the lock is granted. Returns `{ token, lease }`. Throws `AcquireTimeoutError` on timeout.

## Semaphore functions

### `semAcquire(sock, key, acquireTimeoutS, limit, leaseTtlS?)`

Acquire a semaphore slot. Returns `{ token, lease }`.

```ts
import { semAcquire, semRelease, semRenew } from "dflockd-client";

const { token, lease } = await semAcquire(sock, "pool", 10, 5);
```

### `semRenew(sock, key, token, leaseTtlS?)`

Renew the lease on a held semaphore slot. Returns remaining seconds.

```ts
const remaining = await semRenew(sock, "pool", token, 60);
```

### `semRelease(sock, key, token)`

Release a semaphore slot.

```ts
await semRelease(sock, "pool", token);
```

### `semEnqueue(sock, key, limit, leaseTtlS?)`

Two-phase step 1 for semaphores. Returns `{ status, token, lease }`.

```ts
import { semEnqueue, semWaitForLock } from "dflockd-client";

const result = await semEnqueue(sock, "pool", 5);
if (result.status === "queued") {
  const granted = await semWaitForLock(sock, "pool", 10);
}
```

### `semWaitForLock(sock, key, waitTimeoutS)`

Two-phase step 2 for semaphores. Returns `{ token, lease }`. Throws `AcquireTimeoutError` on timeout.

## Full example

```ts
import * as net from "net";
import {
  acquire, enqueue, waitForLock, renew, release,
  semAcquire, semEnqueue, semWaitForLock, semRenew, semRelease,
} from "dflockd-client";

const sock = net.createConnection({ host: "127.0.0.1", port: 6388 });

// Lock — single-phase
const { token, lease } = await acquire(sock, "my-key", 10);
const remaining = await renew(sock, "my-key", token, 60);
await release(sock, "my-key", token);

// Lock — two-phase
const result = await enqueue(sock, "another-key");
if (result.status === "queued") {
  const granted = await waitForLock(sock, "another-key", 10);
}

// Semaphore — single-phase (limit = 5)
const sem = await semAcquire(sock, "sem-key", 10, 5);
const semRemaining = await semRenew(sock, "sem-key", sem.token, 60);
await semRelease(sock, "sem-key", sem.token);

// Semaphore — two-phase
const semResult = await semEnqueue(sock, "sem-key", 5);
if (semResult.status === "queued") {
  const semGranted = await semWaitForLock(sock, "sem-key", 10);
}

sock.destroy();
```
