# TLS & Authentication

## TLS

When the dflockd server is started with `--tls-cert` and `--tls-key`, all connections must use TLS. Pass a `tls` option (Node's `tls.ConnectionOptions`) to enable it:

```ts
import { DistributedLock } from "dflockd-client";

// Default system CA
const lock = new DistributedLock({ key: "my-resource", tls: {} });

// Self-signed CA
import * as fs from "fs";
const lock2 = new DistributedLock({
  key: "my-resource",
  tls: { ca: fs.readFileSync("ca.pem") },
});
```

The `tls` option works the same on `DistributedSemaphore`, `SignalConnection.connect()`, and `stats()`.

## Authentication

When the server is started with `--auth-token`, every connection must authenticate. Pass the `auth` option:

```ts
const lock = new DistributedLock({
  key: "my-resource",
  auth: "my-secret-token",
});
```

The `auth` option works the same on `DistributedSemaphore`, `SignalConnection.connect()`, and `stats()`.

If authentication fails, an `AuthError` (a subclass of `LockError`) is thrown.

## Combined

```ts
const lock = new DistributedLock({
  key: "my-resource",
  tls: {},
  auth: "my-secret-token",
});
```

!!! warning
    The auth token is sent in plaintext when TLS is not enabled. Always use TLS together with authentication to protect the token in transit.
