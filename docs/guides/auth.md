# Authentication

When the dflockd server is started with `--auth-token`, every connection must authenticate before sending any other command. Pass the `auth` option to enable token-based authentication.

## Lock with auth

```ts
import { DistributedLock } from "dflockd-client";

const lock = new DistributedLock({
  key: "my-resource",
  auth: "my-secret-token",
});
```

## Semaphore with auth

```ts
import { DistributedSemaphore } from "dflockd-client";

const sem = new DistributedSemaphore({
  key: "my-resource",
  limit: 5,
  auth: "my-secret-token",
});
```

## Stats with auth

```ts
import { stats } from "dflockd-client";

const s = await stats({
  host: "10.0.0.1",
  port: 6388,
  auth: "my-secret-token",
});
```

## Error handling

If authentication fails, an `AuthError` (a subclass of `LockError`) is thrown:

```ts
import { DistributedLock, AuthError } from "dflockd-client";

try {
  const lock = new DistributedLock({
    key: "my-resource",
    auth: "wrong-token",
  });
  await lock.acquire();
} catch (err) {
  if (err instanceof AuthError) {
    console.error("bad token");
  }
}
```

!!! warning
    The auth token is sent in plaintext over the wire. Use together with TLS (`tls: {}`) to protect the token in transit.
