# Installation

## Requirements

- Node.js 16+
- A running [dflockd](https://github.com/mtingers/dflockd) server

## Install the client

```bash
npm install dflockd-client
```

## Start the dflockd server

The client connects to a dflockd server. Install and run it:

```bash
# Install with Go
go install github.com/mtingers/dflockd/cmd/dflockd@latest

# Start with defaults (127.0.0.1:6388)
dflockd
```

See the [dflockd documentation](https://github.com/mtingers/dflockd) for server configuration options.

## Verify

```ts
import { DistributedLock } from "dflockd-client";

const lock = new DistributedLock({ key: "test" });
const ok = await lock.acquire();
console.log("acquired:", ok);
await lock.release();
```
