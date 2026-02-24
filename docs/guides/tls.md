# TLS

When the dflockd server is started with `--tls-cert` and `--tls-key`, all connections must use TLS. Pass a `tls` option (accepting Node's `tls.ConnectionOptions`) to enable encrypted connections.

## Default system CA

```ts
import { DistributedLock } from "dflockd-client";

const lock = new DistributedLock({
  key: "my-resource",
  tls: {},
});
```

## Custom CA (self-signed certificates)

```ts
import * as fs from "fs";
import { DistributedLock } from "dflockd-client";

const lock = new DistributedLock({
  key: "my-resource",
  tls: { ca: fs.readFileSync("ca.pem") },
});
```

## Semaphore over TLS

```ts
import { DistributedSemaphore } from "dflockd-client";

const sem = new DistributedSemaphore({
  key: "my-resource",
  limit: 5,
  tls: {},
});
```

## Stats over TLS

```ts
import { stats } from "dflockd-client";

const s = await stats({ host: "10.0.0.1", port: 6388, tls: {} });
```

## Combined with authentication

```ts
const lock = new DistributedLock({
  key: "my-resource",
  tls: {},
  auth: "my-secret-token",
});
```

!!! warning
    The auth token is sent in plaintext over the wire when TLS is not enabled. Always use TLS together with authentication to protect the token in transit.
