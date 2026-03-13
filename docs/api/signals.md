# Signals (Pub/Sub)

The `SignalConnection` class provides a dedicated pub/sub interface for publishing and subscribing to signals on a dflockd server.

## `SignalConnection`

### `SignalConnection.connect(opts?)`

Connect to a dflockd server and return a `SignalConnection`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | `"127.0.0.1"` | Server host |
| `port` | `number` | `6388` | Server port |
| `tls` | `tls.ConnectionOptions` | `undefined` | TLS options; pass `{}` for system CA |
| `auth` | `string` | `undefined` | Auth token |
| `connectTimeoutMs` | `number` | `undefined` | TCP connect timeout in milliseconds |
| `heartbeatIntervalMs` | `number` | `15000` | Interval between keepalive pings (ms); set to `0` to disable |

```ts
import { SignalConnection } from "dflockd-client";

const conn = await SignalConnection.connect();
```

With options:

```ts
const conn = await SignalConnection.connect({
  host: "10.0.0.1",
  port: 6388,
  tls: {},
  auth: "my-secret-token",
});
```

### `listen(pattern, group?)`

Subscribe to signals matching `pattern`. Patterns support NATS-style wildcards:

- `*` — matches exactly one dot-separated token
- `>` — matches one or more trailing tokens

If `group` is provided, the subscription joins a **queue group** where signals are load-balanced (round-robin) among group members.

```ts
// Match all signals on "events.user.created"
await conn.listen("events.user.created");

// Match any event under "events.user.*"
await conn.listen("events.user.*");

// Match all events under "events.>"
await conn.listen("events.>");

// Queue group — only one member receives each signal
await conn.listen("jobs.>", "worker-group");
```

### `unlisten(pattern, group?)`

Unsubscribe from signals matching `pattern`. The `pattern` and `group` must match a previous `listen()` call.

```ts
await conn.unlisten("events.>");
await conn.unlisten("jobs.>", "worker-group");
```

### `emit(channel, payload)`

Publish a signal on a literal channel (no wildcards). Returns the number of listeners that received the signal.

```ts
const delivered = await conn.emit("events.user.created", "user-123");
console.log(`delivered to ${delivered} listeners`);
```

### `onSignal(listener)` / `offSignal(listener)`

Register or remove a callback for incoming signals. The listener receives a `Signal` object with `channel` and `payload` properties.

```ts
import { SignalConnection, Signal } from "dflockd-client";

const conn = await SignalConnection.connect();
await conn.listen("events.>");

const handler = (sig: Signal) => {
  console.log(`${sig.channel}: ${sig.payload}`);
};

conn.onSignal(handler);
// later:
conn.offSignal(handler);
```

### Async iterator

`SignalConnection` implements `AsyncIterable<Signal>`, so you can use `for await...of` to consume signals. The iterator terminates when the connection closes.

This is an alternative to `onSignal` — use one or the other, not both.

```ts
for await (const sig of conn) {
  console.log(sig.channel, sig.payload);
}
```

### `close()`

Close the connection (idempotent).

```ts
conn.close();
```

### `isClosed`

Read-only property indicating whether the connection is closed.

```ts
if (conn.isClosed) {
  console.log("connection is closed");
}
```

## `Signal` interface

```ts
interface Signal {
  channel: string;
  payload: string;
}
```

## Full example — callback style

```ts
import { SignalConnection } from "dflockd-client";

const conn = await SignalConnection.connect();

await conn.listen("orders.>");

conn.onSignal((sig) => {
  console.log(`[${sig.channel}] ${sig.payload}`);
});

// Publish on the same connection
const n = await conn.emit("orders.created", "order-456");
console.log(`delivered to ${n} listeners`);

// When done:
conn.close();
```

## Full example — async iterator style

```ts
import { SignalConnection } from "dflockd-client";

const conn = await SignalConnection.connect();

await conn.listen("orders.>");

for await (const sig of conn) {
  console.log(`[${sig.channel}] ${sig.payload}`);
  if (sig.payload === "shutdown") break;
}

conn.close();
```

## Queue groups

Queue groups distribute signals across multiple subscribers so that each signal is delivered to exactly one member of the group:

```ts
// Worker 1
const w1 = await SignalConnection.connect();
await w1.listen("tasks.>", "workers");

// Worker 2
const w2 = await SignalConnection.connect();
await w2.listen("tasks.>", "workers");

// Publisher
const pub = await SignalConnection.connect();
await pub.emit("tasks.process", "job-1"); // delivered to w1 OR w2
await pub.emit("tasks.process", "job-2"); // round-robin to the other
```
