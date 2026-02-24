# Error Handling

The client exports three error classes for handling different failure modes.

## Error classes

### `LockError`

Base class for all protocol-level errors. Thrown on unexpected server responses, connection failures, or protocol violations.

```ts
import { LockError } from "dflockd-client";
```

### `AcquireTimeoutError`

Thrown when a lock or semaphore slot cannot be acquired within the configured timeout. Extends `Error` (not `LockError`).

```ts
import { AcquireTimeoutError } from "dflockd-client";
```

`withLock` throws this automatically if acquisition times out. With manual `acquire()`, timeout returns `false` instead of throwing.

### `AuthError`

Thrown when token authentication fails. Extends `LockError`.

```ts
import { AuthError } from "dflockd-client";
```

## Usage

```ts
import {
  DistributedLock,
  AcquireTimeoutError,
  AuthError,
  LockError,
} from "dflockd-client";

const lock = new DistributedLock({
  key: "my-resource",
  auth: "my-token",
});

try {
  await lock.withLock(async () => {
    // critical section
  });
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

## `acquire()` vs `withLock()` timeout behavior

| Method    | On timeout                                   |
|-----------|----------------------------------------------|
| `acquire` | Returns `false`                              |
| `withLock`| Throws `AcquireTimeoutError`                 |
| `wait`    | Returns `false`                              |
