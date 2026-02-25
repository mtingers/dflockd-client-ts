import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as net from "node:net";
import {
  DistributedLock,
  DistributedSemaphore,
  AcquireTimeoutError,
  AuthError,
  LockError,
  stableHashShard,
  stats,
  acquire,
  renew,
  release,
  enqueue,
  waitForLock,
  semAcquire,
  semRenew,
  semRelease,
  semEnqueue,
  semWaitForLock,
} from "./client.js";

// ---------------------------------------------------------------------------
// Mock server helper — creates a TCP server that speaks the dflockd protocol
// ---------------------------------------------------------------------------

function createMockServer(
  handler: (lines: string[], respond: (msg: string) => void) => void,
): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((conn) => {
      let buf = "";
      const lines: string[] = [];
      conn.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          lines.push(buf.slice(0, idx).replace(/\r$/, ""));
          buf = buf.slice(idx + 1);
          // Protocol: commands are 3-line sequences (command, key, arg)
          if (lines.length >= 3) {
            const batch = lines.splice(0, 3);
            handler(batch, (msg) => conn.write(msg + "\n"));
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

function closeMockServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// stableHashShard (pure, no server needed)
// ---------------------------------------------------------------------------

describe("stableHashShard", () => {
  it("returns a stable result for the same key", () => {
    const a = stableHashShard("my-key", 5);
    const b = stableHashShard("my-key", 5);
    assert.equal(a, b);
  });

  it("returns values in [0, numServers)", () => {
    const keys = ["a", "b", "c", "foo", "bar", "lock-1", "lock-2", "🔒"];
    for (const key of keys) {
      const idx = stableHashShard(key, 3);
      assert.ok(idx >= 0 && idx < 3, `${key} -> ${idx} out of range`);
    }
  });

  it("distributes keys across servers", () => {
    const seen = new Set<number>();
    // With enough distinct keys we should hit more than one bucket
    for (let i = 0; i < 100; i++) {
      seen.add(stableHashShard(`key-${i}`, 3));
    }
    assert.ok(seen.size > 1, "all keys mapped to the same server");
  });

  it("returns 0 for a single server", () => {
    assert.equal(stableHashShard("anything", 1), 0);
  });

  it("throws when numServers is 0", () => {
    assert.throws(() => stableHashShard("key", 0), LockError);
  });

  it("throws when numServers is negative", () => {
    assert.throws(() => stableHashShard("key", -1), LockError);
  });
});

// ---------------------------------------------------------------------------
// Key validation (no server needed)
// ---------------------------------------------------------------------------

describe("key validation", () => {
  it("rejects empty key in DistributedLock constructor", () => {
    assert.throws(
      () => new DistributedLock({ key: "" }),
      LockError,
    );
  });

  it("rejects key with newline in DistributedLock constructor", () => {
    assert.throws(
      () => new DistributedLock({ key: "foo\nbar" }),
      LockError,
    );
  });

  it("rejects key with carriage return in DistributedLock constructor", () => {
    assert.throws(
      () => new DistributedLock({ key: "foo\rbar" }),
      LockError,
    );
  });

  it("rejects empty key in DistributedSemaphore constructor", () => {
    assert.throws(
      () => new DistributedSemaphore({ key: "", limit: 3 }),
      LockError,
    );
  });

  it("rejects key with newline in DistributedSemaphore constructor", () => {
    assert.throws(
      () => new DistributedSemaphore({ key: "a\nb", limit: 3 }),
      LockError,
    );
  });
});

// ---------------------------------------------------------------------------
// DistributedLock constructor validation
// ---------------------------------------------------------------------------

describe("DistributedLock constructor", () => {
  it("defaults to 127.0.0.1:6388 when no servers/host/port given", () => {
    const lock = new DistributedLock({ key: "k" });
    assert.deepEqual(lock.servers, [["127.0.0.1", 6388]]);
  });

  it("accepts deprecated host/port and maps to servers", () => {
    const lock = new DistributedLock({ key: "k", host: "10.0.0.1", port: 9999 });
    assert.deepEqual(lock.servers, [["10.0.0.1", 9999]]);
  });

  it("accepts a servers array", () => {
    const servers: Array<[string, number]> = [
      ["10.0.0.1", 6388],
      ["10.0.0.2", 6389],
    ];
    const lock = new DistributedLock({ key: "k", servers });
    assert.deepEqual(lock.servers, servers);
  });

  it("throws on empty servers array", () => {
    assert.throws(
      () => new DistributedLock({ key: "k", servers: [] }),
      LockError,
    );
  });

  it("uses stableHashShard by default", () => {
    const lock = new DistributedLock({ key: "k" });
    assert.equal(lock.shardingStrategy, stableHashShard);
  });

  it("accepts a custom sharding strategy", () => {
    const custom = (_key: string, _n: number) => 0;
    const lock = new DistributedLock({ key: "k", shardingStrategy: custom });
    assert.equal(lock.shardingStrategy, custom);
  });

  it("throws on negative acquireTimeoutS", () => {
    assert.throws(
      () => new DistributedLock({ key: "k", acquireTimeoutS: -1 }),
      LockError,
    );
  });

  it("throws on leaseTtlS <= 0", () => {
    assert.throws(
      () => new DistributedLock({ key: "k", leaseTtlS: 0 }),
      LockError,
    );
    assert.throws(
      () => new DistributedLock({ key: "k", leaseTtlS: -5 }),
      LockError,
    );
  });

  it("throws on renewRatio <= 0", () => {
    assert.throws(
      () => new DistributedLock({ key: "k", renewRatio: 0 }),
      LockError,
    );
    assert.throws(
      () => new DistributedLock({ key: "k", renewRatio: -0.5 }),
      LockError,
    );
  });

  it("throws on renewRatio >= 1", () => {
    assert.throws(
      () => new DistributedLock({ key: "k", renewRatio: 1 }),
      LockError,
    );
    assert.throws(
      () => new DistributedLock({ key: "k", renewRatio: 2 }),
      LockError,
    );
  });

  it("throws on NaN renewRatio", () => {
    assert.throws(
      () => new DistributedLock({ key: "k", renewRatio: NaN }),
      LockError,
    );
  });

  it("throws on Infinity renewRatio", () => {
    assert.throws(
      () => new DistributedLock({ key: "k", renewRatio: Infinity }),
      LockError,
    );
  });

  it("accepts valid renewRatio", () => {
    const lock = new DistributedLock({ key: "k", renewRatio: 0.3 });
    assert.equal(lock.renewRatio, 0.3);
  });
});

// ---------------------------------------------------------------------------
// DistributedSemaphore limit validation (no server needed)
// ---------------------------------------------------------------------------

describe("DistributedSemaphore limit validation", () => {
  it("throws on limit 0", () => {
    assert.throws(
      () => new DistributedSemaphore({ key: "k", limit: 0 }),
      LockError,
    );
  });

  it("throws on negative limit", () => {
    assert.throws(
      () => new DistributedSemaphore({ key: "k", limit: -1 }),
      LockError,
    );
  });

  it("throws on non-integer limit", () => {
    assert.throws(
      () => new DistributedSemaphore({ key: "k", limit: 1.5 }),
      LockError,
    );
  });

  it("accepts valid limit", () => {
    const sem = new DistributedSemaphore({ key: "k", limit: 1 });
    assert.equal(sem.limit, 1);
  });
});

// ---------------------------------------------------------------------------
// socketTimeoutMs option (no server needed)
// ---------------------------------------------------------------------------

describe("DistributedLock socketTimeoutMs option", () => {
  it("stores socketTimeoutMs on the instance", () => {
    const lock = new DistributedLock({ key: "k", socketTimeoutMs: 30000 });
    assert.equal(lock.socketTimeoutMs, 30000);
  });

  it("defaults socketTimeoutMs to undefined when not provided", () => {
    const lock = new DistributedLock({ key: "k" });
    assert.equal(lock.socketTimeoutMs, undefined);
  });
});

// ---------------------------------------------------------------------------
// TLS option (no server needed)
// ---------------------------------------------------------------------------

describe("DistributedLock tls option", () => {
  it("stores tls option on the instance", () => {
    const tlsOpts = { rejectUnauthorized: false };
    const lock = new DistributedLock({ key: "k", tls: tlsOpts });
    assert.deepEqual(lock.tls, tlsOpts);
  });

  it("defaults tls to undefined when not provided", () => {
    const lock = new DistributedLock({ key: "k" });
    assert.equal(lock.tls, undefined);
  });
});

describe("DistributedSemaphore tls option", () => {
  it("stores tls option on the instance", () => {
    const tlsOpts = { rejectUnauthorized: false };
    const sem = new DistributedSemaphore({ key: "k", limit: 3, tls: tlsOpts });
    assert.deepEqual(sem.tls, tlsOpts);
  });

  it("defaults tls to undefined when not provided", () => {
    const sem = new DistributedSemaphore({ key: "k", limit: 3 });
    assert.equal(sem.tls, undefined);
  });
});

// ---------------------------------------------------------------------------
// Auth option (no server needed)
// ---------------------------------------------------------------------------

describe("DistributedLock auth option", () => {
  it("stores auth option on the instance", () => {
    const lock = new DistributedLock({ key: "k", auth: "my-secret" });
    assert.equal(lock.auth, "my-secret");
  });

  it("defaults auth to undefined when not provided", () => {
    const lock = new DistributedLock({ key: "k" });
    assert.equal(lock.auth, undefined);
  });
});

describe("DistributedSemaphore auth option", () => {
  it("stores auth option on the instance", () => {
    const sem = new DistributedSemaphore({ key: "k", limit: 3, auth: "my-secret" });
    assert.equal(sem.auth, "my-secret");
  });

  it("defaults auth to undefined when not provided", () => {
    const sem = new DistributedSemaphore({ key: "k", limit: 3 });
    assert.equal(sem.auth, undefined);
  });
});

// ---------------------------------------------------------------------------
// connectTimeoutMs option (no server needed)
// ---------------------------------------------------------------------------

describe("DistributedLock connectTimeoutMs option", () => {
  it("stores connectTimeoutMs on the instance", () => {
    const lock = new DistributedLock({ key: "k", connectTimeoutMs: 5000 });
    assert.equal(lock.connectTimeoutMs, 5000);
  });

  it("defaults connectTimeoutMs to undefined when not provided", () => {
    const lock = new DistributedLock({ key: "k" });
    assert.equal(lock.connectTimeoutMs, undefined);
  });
});

describe("DistributedSemaphore connectTimeoutMs option", () => {
  it("stores connectTimeoutMs on the instance", () => {
    const sem = new DistributedSemaphore({ key: "k", limit: 3, connectTimeoutMs: 5000 });
    assert.equal(sem.connectTimeoutMs, 5000);
  });

  it("defaults connectTimeoutMs to undefined when not provided", () => {
    const sem = new DistributedSemaphore({ key: "k", limit: 3 });
    assert.equal(sem.connectTimeoutMs, undefined);
  });
});

// ---------------------------------------------------------------------------
// close() resets lease (no server needed)
// ---------------------------------------------------------------------------

describe("close() resets lease", () => {
  it("resets lease to 0 on DistributedLock", () => {
    const lock = new DistributedLock({ key: "k" });
    // Simulate a lease value being set
    lock.lease = 30;
    lock.close();
    assert.equal(lock.lease, 0);
  });

  it("resets lease to 0 on DistributedSemaphore", () => {
    const sem = new DistributedSemaphore({ key: "k", limit: 3 });
    sem.lease = 30;
    sem.close();
    assert.equal(sem.lease, 0);
  });
});

describe("AuthError", () => {
  it("is an instance of LockError", () => {
    const err = new AuthError();
    assert.ok(err instanceof LockError);
    assert.equal(err.name, "AuthError");
    assert.equal(err.message, "authentication failed");
  });
});

// ---------------------------------------------------------------------------
// Bug #3: AcquireTimeoutError extends LockError
// ---------------------------------------------------------------------------

describe("AcquireTimeoutError", () => {
  it("is an instance of LockError", () => {
    const err = new AcquireTimeoutError("my-key");
    assert.ok(err instanceof LockError);
    assert.ok(err instanceof Error);
    assert.equal(err.name, "AcquireTimeoutError");
    assert.match(err.message, /my-key/);
  });
});

// ---------------------------------------------------------------------------
// Issue #4: onLockLost callback option
// ---------------------------------------------------------------------------

describe("DistributedLock onLockLost option", () => {
  it("stores onLockLost on the instance", () => {
    const cb = (_key: string, _token: string) => {};
    const lock = new DistributedLock({ key: "k", onLockLost: cb });
    assert.equal(lock.onLockLost, cb);
  });

  it("defaults onLockLost to undefined when not provided", () => {
    const lock = new DistributedLock({ key: "k" });
    assert.equal(lock.onLockLost, undefined);
  });
});

describe("DistributedSemaphore onLockLost option", () => {
  it("stores onLockLost on the instance", () => {
    const cb = (_key: string, _token: string) => {};
    const sem = new DistributedSemaphore({ key: "k", limit: 3, onLockLost: cb });
    assert.equal(sem.onLockLost, cb);
  });

  it("defaults onLockLost to undefined when not provided", () => {
    const sem = new DistributedSemaphore({ key: "k", limit: 3 });
    assert.equal(sem.onLockLost, undefined);
  });
});

// ---------------------------------------------------------------------------
// Issue #10: pickServer bounds checking
// ---------------------------------------------------------------------------

describe("DistributedLock pickServer bounds checking", () => {
  it("throws LockError when shardingStrategy returns negative index", async () => {
    const lock = new DistributedLock({
      key: "k",
      shardingStrategy: () => -1,
    });
    await assert.rejects(() => lock.acquire(), LockError);
  });

  it("throws LockError when shardingStrategy returns index >= servers.length", async () => {
    const lock = new DistributedLock({
      key: "k",
      shardingStrategy: () => 1,
      // only 1 server, so index 1 is out of bounds
    });
    await assert.rejects(() => lock.acquire(), LockError);
  });

  it("throws LockError when shardingStrategy returns non-integer", async () => {
    const lock = new DistributedLock({
      key: "k",
      shardingStrategy: () => 0.5,
    });
    await assert.rejects(() => lock.acquire(), LockError);
  });

  it("throws LockError when shardingStrategy returns NaN", async () => {
    const lock = new DistributedLock({
      key: "k",
      shardingStrategy: () => NaN,
    });
    await assert.rejects(() => lock.acquire(), LockError);
  });
});

describe("DistributedSemaphore pickServer bounds checking", () => {
  it("throws LockError when shardingStrategy returns negative index", async () => {
    const sem = new DistributedSemaphore({
      key: "k",
      limit: 3,
      shardingStrategy: () => -1,
    });
    await assert.rejects(() => sem.acquire(), LockError);
  });

  it("throws LockError when shardingStrategy returns index >= servers.length", async () => {
    const sem = new DistributedSemaphore({
      key: "k",
      limit: 3,
      shardingStrategy: () => 1,
    });
    await assert.rejects(() => sem.acquire(), LockError);
  });
});

// ---------------------------------------------------------------------------
// Protocol function input validation (mock socket, no server needed)
// ---------------------------------------------------------------------------

describe("acquire() input validation", () => {
  const fakeSock = new net.Socket();

  it("rejects empty key", async () => {
    await assert.rejects(() => acquire(fakeSock, "", 10), LockError);
  });

  it("rejects key with NUL byte", async () => {
    await assert.rejects(() => acquire(fakeSock, "a\0b", 10), LockError);
  });

  it("rejects key with newline", async () => {
    await assert.rejects(() => acquire(fakeSock, "a\nb", 10), LockError);
  });

  it("rejects key with carriage return", async () => {
    await assert.rejects(() => acquire(fakeSock, "a\rb", 10), LockError);
  });

  it("rejects negative acquireTimeoutS", async () => {
    await assert.rejects(() => acquire(fakeSock, "k", -1), LockError);
  });

  it("rejects NaN acquireTimeoutS", async () => {
    await assert.rejects(() => acquire(fakeSock, "k", NaN), LockError);
  });

  it("rejects Infinity acquireTimeoutS", async () => {
    await assert.rejects(() => acquire(fakeSock, "k", Infinity), LockError);
  });

  it("rejects leaseTtlS = 0", async () => {
    await assert.rejects(() => acquire(fakeSock, "k", 10, 0), LockError);
  });

  it("rejects negative leaseTtlS", async () => {
    await assert.rejects(() => acquire(fakeSock, "k", 10, -5), LockError);
  });

  it("rejects NaN leaseTtlS", async () => {
    await assert.rejects(() => acquire(fakeSock, "k", 10, NaN), LockError);
  });

  it("rejects Infinity leaseTtlS", async () => {
    await assert.rejects(() => acquire(fakeSock, "k", 10, Infinity), LockError);
  });
});

describe("renew() input validation", () => {
  const fakeSock = new net.Socket();

  it("rejects empty key", async () => {
    await assert.rejects(() => renew(fakeSock, "", "tok"), LockError);
  });

  it("rejects key with NUL byte", async () => {
    await assert.rejects(() => renew(fakeSock, "a\0b", "tok"), LockError);
  });

  it("rejects empty token", async () => {
    await assert.rejects(() => renew(fakeSock, "k", ""), LockError);
  });

  it("rejects token with NUL byte", async () => {
    await assert.rejects(() => renew(fakeSock, "k", "t\0k"), LockError);
  });

  it("rejects token with newline", async () => {
    await assert.rejects(() => renew(fakeSock, "k", "t\nk"), LockError);
  });

  it("rejects leaseTtlS = 0", async () => {
    await assert.rejects(() => renew(fakeSock, "k", "tok", 0), LockError);
  });

  it("rejects negative leaseTtlS", async () => {
    await assert.rejects(() => renew(fakeSock, "k", "tok", -1), LockError);
  });

  it("rejects NaN leaseTtlS", async () => {
    await assert.rejects(() => renew(fakeSock, "k", "tok", NaN), LockError);
  });
});

describe("release() input validation", () => {
  const fakeSock = new net.Socket();

  it("rejects empty key", async () => {
    await assert.rejects(() => release(fakeSock, "", "tok"), LockError);
  });

  it("rejects key with NUL byte", async () => {
    await assert.rejects(() => release(fakeSock, "a\0b", "tok"), LockError);
  });

  it("rejects empty token", async () => {
    await assert.rejects(() => release(fakeSock, "k", ""), LockError);
  });

  it("rejects token with NUL byte", async () => {
    await assert.rejects(() => release(fakeSock, "k", "t\0k"), LockError);
  });
});

describe("enqueue() input validation", () => {
  const fakeSock = new net.Socket();

  it("rejects empty key", async () => {
    await assert.rejects(() => enqueue(fakeSock, "", 10), LockError);
  });

  it("rejects key with NUL byte", async () => {
    await assert.rejects(() => enqueue(fakeSock, "a\0b", 10), LockError);
  });

  it("rejects leaseTtlS = 0", async () => {
    await assert.rejects(() => enqueue(fakeSock, "k", 0), LockError);
  });

  it("rejects negative leaseTtlS", async () => {
    await assert.rejects(() => enqueue(fakeSock, "k", -1), LockError);
  });
});

describe("waitForLock() input validation", () => {
  const fakeSock = new net.Socket();

  it("rejects empty key", async () => {
    await assert.rejects(() => waitForLock(fakeSock, "", 10), LockError);
  });

  it("rejects key with NUL byte", async () => {
    await assert.rejects(() => waitForLock(fakeSock, "a\0b", 10), LockError);
  });

  it("rejects negative waitTimeoutS", async () => {
    await assert.rejects(() => waitForLock(fakeSock, "k", -1), LockError);
  });

  it("rejects NaN waitTimeoutS", async () => {
    await assert.rejects(() => waitForLock(fakeSock, "k", NaN), LockError);
  });

  it("rejects Infinity waitTimeoutS", async () => {
    await assert.rejects(() => waitForLock(fakeSock, "k", Infinity), LockError);
  });
});

describe("semAcquire() input validation", () => {
  const fakeSock = new net.Socket();

  it("rejects empty key", async () => {
    await assert.rejects(() => semAcquire(fakeSock, "", 10, 3), LockError);
  });

  it("rejects key with NUL byte", async () => {
    await assert.rejects(() => semAcquire(fakeSock, "a\0b", 10, 3), LockError);
  });

  it("rejects negative acquireTimeoutS", async () => {
    await assert.rejects(() => semAcquire(fakeSock, "k", -1, 3), LockError);
  });

  it("rejects non-integer limit", async () => {
    await assert.rejects(() => semAcquire(fakeSock, "k", 10, 1.5), LockError);
  });

  it("rejects limit = 0", async () => {
    await assert.rejects(() => semAcquire(fakeSock, "k", 10, 0), LockError);
  });

  it("rejects negative limit", async () => {
    await assert.rejects(() => semAcquire(fakeSock, "k", 10, -1), LockError);
  });

  it("rejects leaseTtlS = 0", async () => {
    await assert.rejects(() => semAcquire(fakeSock, "k", 10, 3, 0), LockError);
  });

  it("rejects NaN leaseTtlS", async () => {
    await assert.rejects(() => semAcquire(fakeSock, "k", 10, 3, NaN), LockError);
  });
});

describe("semRenew() input validation", () => {
  const fakeSock = new net.Socket();

  it("rejects empty key", async () => {
    await assert.rejects(() => semRenew(fakeSock, "", "tok"), LockError);
  });

  it("rejects empty token", async () => {
    await assert.rejects(() => semRenew(fakeSock, "k", ""), LockError);
  });

  it("rejects token with NUL byte", async () => {
    await assert.rejects(() => semRenew(fakeSock, "k", "t\0k"), LockError);
  });

  it("rejects leaseTtlS = 0", async () => {
    await assert.rejects(() => semRenew(fakeSock, "k", "tok", 0), LockError);
  });
});

describe("semRelease() input validation", () => {
  const fakeSock = new net.Socket();

  it("rejects empty key", async () => {
    await assert.rejects(() => semRelease(fakeSock, "", "tok"), LockError);
  });

  it("rejects empty token", async () => {
    await assert.rejects(() => semRelease(fakeSock, "k", ""), LockError);
  });

  it("rejects token with carriage return", async () => {
    await assert.rejects(() => semRelease(fakeSock, "k", "t\rk"), LockError);
  });
});

describe("semEnqueue() input validation", () => {
  const fakeSock = new net.Socket();

  it("rejects empty key", async () => {
    await assert.rejects(() => semEnqueue(fakeSock, "", 3), LockError);
  });

  it("rejects non-integer limit", async () => {
    await assert.rejects(() => semEnqueue(fakeSock, "k", 1.5), LockError);
  });

  it("rejects limit = 0", async () => {
    await assert.rejects(() => semEnqueue(fakeSock, "k", 0), LockError);
  });

  it("rejects leaseTtlS = 0", async () => {
    await assert.rejects(() => semEnqueue(fakeSock, "k", 3, 0), LockError);
  });
});

describe("semWaitForLock() input validation", () => {
  const fakeSock = new net.Socket();

  it("rejects empty key", async () => {
    await assert.rejects(() => semWaitForLock(fakeSock, "", 10), LockError);
  });

  it("rejects negative waitTimeoutS", async () => {
    await assert.rejects(() => semWaitForLock(fakeSock, "k", -1), LockError);
  });

  it("rejects NaN waitTimeoutS", async () => {
    await assert.rejects(() => semWaitForLock(fakeSock, "k", NaN), LockError);
  });
});

// ---------------------------------------------------------------------------
// Protocol functions with mock server (response parsing, edge cases)
// ---------------------------------------------------------------------------

describe("acquire() response parsing (mock server)", () => {
  it("parses ok response with token and lease", async () => {
    const { server, port } = await createMockServer((lines, respond) => {
      assert.equal(lines[0], "l");
      respond("ok abc123 30");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const result = await acquire(sock, "mykey", 10);
      assert.equal(result.token, "abc123");
      assert.equal(result.lease, 30);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("defaults lease to 30 when server omits it", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("ok abc123");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const result = await acquire(sock, "mykey", 10);
      assert.equal(result.token, "abc123");
      assert.equal(result.lease, 30);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("falls back to 30 for non-numeric lease", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("ok abc123 notanumber");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const result = await acquire(sock, "mykey", 10);
      assert.equal(result.lease, 30);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("falls back to 30 for negative lease", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("ok abc123 -5");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const result = await acquire(sock, "mykey", 10);
      assert.equal(result.lease, 30);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("accepts lease = 0", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("ok abc123 0");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const result = await acquire(sock, "mykey", 10);
      assert.equal(result.lease, 0);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("throws AcquireTimeoutError on timeout response", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("timeout");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      await assert.rejects(
        () => acquire(sock, "mykey", 10),
        AcquireTimeoutError,
      );
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("throws LockError on unknown response", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("error_something");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      await assert.rejects(
        () => acquire(sock, "mykey", 10),
        LockError,
      );
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("sends correct protocol lines with leaseTtlS", async () => {
    const sentLines: string[][] = [];
    const { server, port } = await createMockServer((lines, respond) => {
      sentLines.push([...lines]);
      respond("ok tok1 15");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      await acquire(sock, "mykey", 10, 20);
      assert.equal(sentLines[0][0], "l");
      assert.equal(sentLines[0][1], "mykey");
      assert.equal(sentLines[0][2], "10 20");
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("sends correct protocol lines without leaseTtlS", async () => {
    const sentLines: string[][] = [];
    const { server, port } = await createMockServer((lines, respond) => {
      sentLines.push([...lines]);
      respond("ok tok1 30");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      await acquire(sock, "mykey", 10);
      assert.equal(sentLines[0][2], "10");
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });
});

describe("renew() response parsing (mock server)", () => {
  it("parses ok response with lease", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("ok 45");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const lease = await renew(sock, "mykey", "tok1");
      assert.equal(lease, 45);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("returns leaseTtlS on bare ok response", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("ok");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const lease = await renew(sock, "mykey", "tok1", 20);
      assert.equal(lease, 20);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("returns default 30 on bare ok response without leaseTtlS", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("ok");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const lease = await renew(sock, "mykey", "tok1");
      assert.equal(lease, 30);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("falls back to 30 for non-numeric lease in ok response", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("ok garbage");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const lease = await renew(sock, "mykey", "tok1");
      assert.equal(lease, 30);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("throws LockError on error response", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("error_expired");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      await assert.rejects(() => renew(sock, "mykey", "tok1"), LockError);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });
});

describe("release() response parsing (mock server)", () => {
  it("resolves on ok", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("ok");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      await release(sock, "mykey", "tok1"); // should not throw
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("throws LockError on error response", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("error_not_owner");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      await assert.rejects(() => release(sock, "mykey", "tok1"), LockError);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });
});

describe("enqueue() response parsing (mock server)", () => {
  it("parses acquired response with token and lease", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("acquired tok1 25");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const result = await enqueue(sock, "mykey");
      assert.equal(result.status, "acquired");
      assert.equal(result.token, "tok1");
      assert.equal(result.lease, 25);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("parses queued response", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("queued");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const result = await enqueue(sock, "mykey");
      assert.equal(result.status, "queued");
      assert.equal(result.token, null);
      assert.equal(result.lease, null);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("throws LockError on unknown response", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("error_something");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      await assert.rejects(() => enqueue(sock, "mykey"), LockError);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });
});

describe("waitForLock() response parsing (mock server)", () => {
  it("parses ok response with token and lease", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("ok tok1 15");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const result = await waitForLock(sock, "mykey", 10);
      assert.equal(result.token, "tok1");
      assert.equal(result.lease, 15);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("throws AcquireTimeoutError on timeout", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("timeout");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      await assert.rejects(
        () => waitForLock(sock, "mykey", 10),
        AcquireTimeoutError,
      );
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// Semaphore protocol functions with mock server
// ---------------------------------------------------------------------------

describe("semAcquire() response parsing (mock server)", () => {
  it("parses ok response with token and lease", async () => {
    const { server, port } = await createMockServer((lines, respond) => {
      assert.equal(lines[0], "sl");
      respond("ok semtok 20");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const result = await semAcquire(sock, "mykey", 10, 3);
      assert.equal(result.token, "semtok");
      assert.equal(result.lease, 20);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("sends correct args with leaseTtlS", async () => {
    const sentLines: string[][] = [];
    const { server, port } = await createMockServer((lines, respond) => {
      sentLines.push([...lines]);
      respond("ok semtok 20");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      await semAcquire(sock, "mykey", 10, 3, 15);
      assert.equal(sentLines[0][2], "10 3 15");
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("throws AcquireTimeoutError on timeout", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("timeout");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      await assert.rejects(
        () => semAcquire(sock, "mykey", 10, 3),
        AcquireTimeoutError,
      );
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });
});

describe("semRenew() response parsing (mock server)", () => {
  it("parses ok response with lease", async () => {
    const { server, port } = await createMockServer((lines, respond) => {
      assert.equal(lines[0], "sn");
      respond("ok 50");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const lease = await semRenew(sock, "mykey", "tok1");
      assert.equal(lease, 50);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("returns default on bare ok", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("ok");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const lease = await semRenew(sock, "mykey", "tok1");
      assert.equal(lease, 30);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });
});

describe("semEnqueue() response parsing (mock server)", () => {
  it("parses acquired response", async () => {
    const { server, port } = await createMockServer((lines, respond) => {
      assert.equal(lines[0], "se");
      respond("acquired stok 10");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const result = await semEnqueue(sock, "mykey", 3);
      assert.equal(result.status, "acquired");
      assert.equal(result.token, "stok");
      assert.equal(result.lease, 10);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("parses queued response", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("queued");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const result = await semEnqueue(sock, "mykey", 3);
      assert.equal(result.status, "queued");
      assert.equal(result.token, null);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });
});

describe("semWaitForLock() response parsing (mock server)", () => {
  it("parses ok response", async () => {
    const { server, port } = await createMockServer((lines, respond) => {
      assert.equal(lines[0], "sw");
      respond("ok stok2 12");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const result = await semWaitForLock(sock, "mykey", 10);
      assert.equal(result.token, "stok2");
      assert.equal(result.lease, 12);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("throws AcquireTimeoutError on timeout", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("timeout");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      await assert.rejects(
        () => semWaitForLock(sock, "mykey", 10),
        AcquireTimeoutError,
      );
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });
});

describe("semRelease() response parsing (mock server)", () => {
  it("resolves on ok", async () => {
    const { server, port } = await createMockServer((lines, respond) => {
      assert.equal(lines[0], "sr");
      respond("ok");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      await semRelease(sock, "mykey", "tok1");
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("throws LockError on error response", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("error_not_owner");
    });
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      await assert.rejects(() => semRelease(sock, "mykey", "tok1"), LockError);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// DistributedLock / DistributedSemaphore with mock server
// ---------------------------------------------------------------------------

describe("DistributedLock with mock server", () => {
  it("release() throws after close()", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("ok tok1 30");
    });
    try {
      const lock = new DistributedLock({ key: "k", host: "127.0.0.1", port });
      await lock.acquire();
      lock.close();
      await assert.rejects(() => lock.release(), LockError);
    } finally {
      await closeMockServer(server);
    }
  });

  it("release() throws after double release", async () => {
    let callCount = 0;
    const { server: s2, port: p2 } = await createMockServer((_lines, respond) => {
      callCount++;
      if (callCount === 1) {
        respond("ok tok1 30"); // acquire
      } else {
        respond("ok"); // release
      }
    });
    try {
      const lock = new DistributedLock({ key: "k", host: "127.0.0.1", port: p2 });
      await lock.acquire();
      await lock.release();
      // Second release should throw because close() was called
      await assert.rejects(() => lock.release(), LockError);
    } finally {
      await closeMockServer(s2);
    }
  });

  it("wait() throws after close()", async () => {
    const lock = new DistributedLock({ key: "k" });
    lock.close();
    await assert.rejects(() => lock.wait(), LockError);
  });

  it("close() is idempotent", () => {
    const lock = new DistributedLock({ key: "k" });
    lock.close();
    lock.close(); // should not throw
    lock.close(); // should not throw
  });

  it("close() resets token and lease", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("ok tok1 30");
    });
    try {
      const lock = new DistributedLock({ key: "k", host: "127.0.0.1", port });
      await lock.acquire();
      assert.ok(lock.token !== null);
      assert.ok(lock.lease > 0);
      lock.close();
      assert.equal(lock.token, null);
      assert.equal(lock.lease, 0);
    } finally {
      await closeMockServer(server);
    }
  });

  it("withLock preserves fn error over release error", async () => {
    let callCount = 0;
    const { server, port } = await createMockServer((_lines, respond) => {
      callCount++;
      if (callCount === 1) {
        // acquire succeeds
        respond("ok tok1 30");
      } else {
        // release fails
        respond("error_something");
      }
    });
    try {
      const lock = new DistributedLock({ key: "k", host: "127.0.0.1", port });
      await assert.rejects(
        () =>
          lock.withLock(async () => {
            throw new Error("original error");
          }),
        // The original error from fn() should be preserved, not masked by the
        // release failure.
        { message: "original error" },
      );
    } finally {
      await closeMockServer(server);
    }
  });

  it("connectTimeoutMs causes timeout on unresponsive host", async () => {
    // Connect to a non-routable address to trigger connect timeout.
    // 192.0.2.1 is TEST-NET-1 (RFC 5737), should be unroutable.
    const lock = new DistributedLock({
      key: "k",
      host: "192.0.2.1",
      port: 6388,
      connectTimeoutMs: 200,
    });
    const start = Date.now();
    await assert.rejects(() => lock.acquire(), LockError);
    const elapsed = Date.now() - start;
    // Should have timed out around 200ms, give generous margin
    assert.ok(elapsed < 5000, `expected fast timeout, got ${elapsed}ms`);
  });
});

describe("renew failure tears down connection", () => {
  it("close()s the instance so acquire() can be called again", async () => {
    let callCount = 0;
    const { server, port } = await createMockServer((_lines, respond) => {
      callCount++;
      if (callCount === 1) {
        // acquire succeeds with a very short lease so the renew fires quickly
        respond("ok tok1 1");
      } else {
        // renew fails
        respond("error_expired");
      }
    });
    try {
      let lostKey: string | undefined;
      let lostToken: string | undefined;
      const lock = new DistributedLock({
        key: "k",
        host: "127.0.0.1",
        port,
        renewRatio: 0.01, // renew fires almost immediately
        onLockLost: (k, t) => {
          lostKey = k;
          lostToken = t;
        },
      });
      await lock.acquire();
      assert.equal(lock.token, "tok1");

      // Wait long enough for the renew to fire and fail.
      // Min renew interval is Math.max(1, lease * ratio) * 1000 = 1000ms.
      await new Promise((r) => setTimeout(r, 1500));

      // onLockLost should have been called
      assert.equal(lostKey, "k");
      assert.equal(lostToken, "tok1");

      // Instance should be fully closed: token/lease reset, socket torn down
      assert.equal(lock.token, null);
      assert.equal(lock.lease, 0);

      // A subsequent acquire() without { force: true } should NOT throw
      // "already connected" — it should attempt a fresh connection.
      // We close the mock server first so acquire() will fail with a
      // connection error, which proves it tried to connect (not rejected
      // with "already connected").
      await closeMockServer(server);
      const err = await lock.acquire().then(
        () => null,
        (e: Error) => e,
      );
      // Should be a connection error, not "already connected"
      assert.ok(err !== null, "expected acquire() to fail after server closed");
      assert.ok(
        !err!.message.includes("already connected"),
        `expected connection error, got: ${err!.message}`,
      );
    } finally {
      // Server may already be closed above; ignore errors
      await closeMockServer(server).catch(() => {});
    }
  });

  it("cleans up even without onLockLost callback", async () => {
    let callCount = 0;
    const { server, port } = await createMockServer((_lines, respond) => {
      callCount++;
      if (callCount === 1) {
        respond("ok tok1 1");
      } else {
        respond("error_expired");
      }
    });
    try {
      const lock = new DistributedLock({
        key: "k",
        host: "127.0.0.1",
        port,
        renewRatio: 0.01,
        // no onLockLost
      });
      await lock.acquire();
      assert.equal(lock.token, "tok1");

      await new Promise((r) => setTimeout(r, 1500));

      // Instance should still be cleaned up
      assert.equal(lock.token, null);
      assert.equal(lock.lease, 0);
    } finally {
      await closeMockServer(server);
    }
  });
});

describe("DistributedSemaphore with mock server", () => {
  it("acquire and release round-trip", async () => {
    let callCount = 0;
    const { server, port } = await createMockServer((_lines, respond) => {
      callCount++;
      if (callCount === 1) {
        respond("ok semtok 20");
      } else {
        respond("ok");
      }
    });
    try {
      const sem = new DistributedSemaphore({ key: "k", limit: 3, host: "127.0.0.1", port });
      const ok = await sem.acquire();
      assert.equal(ok, true);
      assert.equal(sem.token, "semtok");
      assert.equal(sem.lease, 20);
      await sem.release();
      assert.equal(sem.token, null);
    } finally {
      await closeMockServer(server);
    }
  });

  it("acquire returns false on timeout", async () => {
    const { server, port } = await createMockServer((_lines, respond) => {
      respond("timeout");
    });
    try {
      const sem = new DistributedSemaphore({ key: "k", limit: 3, host: "127.0.0.1", port });
      const ok = await sem.acquire();
      assert.equal(ok, false);
    } finally {
      await closeMockServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// Constructor validation for NaN/Infinity edge cases
// ---------------------------------------------------------------------------

describe("constructor NaN/Infinity edge cases", () => {
  it("rejects NaN acquireTimeoutS", () => {
    assert.throws(
      () => new DistributedLock({ key: "k", acquireTimeoutS: NaN }),
      LockError,
    );
  });

  it("rejects Infinity acquireTimeoutS", () => {
    assert.throws(
      () => new DistributedLock({ key: "k", acquireTimeoutS: Infinity }),
      LockError,
    );
  });

  it("rejects NaN leaseTtlS", () => {
    assert.throws(
      () => new DistributedLock({ key: "k", leaseTtlS: NaN }),
      LockError,
    );
  });

  it("rejects Infinity leaseTtlS", () => {
    assert.throws(
      () => new DistributedLock({ key: "k", leaseTtlS: Infinity }),
      LockError,
    );
  });

  it("rejects -Infinity renewRatio", () => {
    assert.throws(
      () => new DistributedLock({ key: "k", renewRatio: -Infinity }),
      LockError,
    );
  });

  it("semaphore rejects NaN acquireTimeoutS", () => {
    assert.throws(
      () => new DistributedSemaphore({ key: "k", limit: 3, acquireTimeoutS: NaN }),
      LockError,
    );
  });

  it("semaphore rejects NaN leaseTtlS", () => {
    assert.throws(
      () => new DistributedSemaphore({ key: "k", limit: 3, leaseTtlS: NaN }),
      LockError,
    );
  });

  it("semaphore rejects NaN renewRatio", () => {
    assert.throws(
      () => new DistributedSemaphore({ key: "k", limit: 3, renewRatio: NaN }),
      LockError,
    );
  });
});

// ---------------------------------------------------------------------------
// Key validation: NUL byte in constructor
// ---------------------------------------------------------------------------

describe("key validation: NUL byte", () => {
  it("rejects key with NUL in DistributedLock constructor", () => {
    assert.throws(
      () => new DistributedLock({ key: "a\0b" }),
      LockError,
    );
  });

  it("rejects key with NUL in DistributedSemaphore constructor", () => {
    assert.throws(
      () => new DistributedSemaphore({ key: "a\0b", limit: 3 }),
      LockError,
    );
  });
});

// ---------------------------------------------------------------------------
// readline: server closes connection before full line
// ---------------------------------------------------------------------------

describe("readline edge cases (mock server)", () => {
  it("rejects when server closes connection before sending a line", async () => {
    const server = net.createServer((conn) => {
      // Write partial data without newline, then destroy the connection.
      // Using destroy() instead of end() ensures the server-side socket
      // is fully closed so server.close() doesn't hang.
      conn.write("partial");
      conn.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      // May throw LockError ("server closed connection") or native Error
      // ("read ECONNRESET") depending on timing.
      await assert.rejects(
        () => acquire(sock, "mykey", 10),
        Error,
      );
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });

  it("handles \\r\\n line endings", async () => {
    const server = net.createServer((conn) => {
      conn.on("data", () => {
        conn.write("ok tok1 30\r\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((r) => sock.on("connect", r));
      const result = await acquire(sock, "mykey", 10);
      assert.equal(result.token, "tok1");
      assert.equal(result.lease, 30);
      sock.destroy();
    } finally {
      await closeMockServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// Connection leak: auth handshake failure destroys socket
// ---------------------------------------------------------------------------

describe("connect() auth handshake socket cleanup", () => {
  it("destroys socket when server closes during auth", async () => {
    // Server accepts the connection then immediately closes it,
    // simulating a crash during the auth handshake.
    const server = net.createServer((conn) => {
      conn.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const lock = new DistributedLock({
        key: "k",
        host: "127.0.0.1",
        port,
        auth: "my-secret",
      });
      // The error may be ECONNRESET (native) or LockError depending on timing
      await assert.rejects(() => lock.acquire());
      // After the error, the lock should be fully closed (no leaked socket)
      lock.close();
    } finally {
      await closeMockServer(server);
    }
  });

  it("destroys socket on auth rejection", async () => {
    // Server responds with auth failure
    const server = net.createServer((conn) => {
      let buf = "";
      conn.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
        if (buf.includes("\n")) {
          conn.write("error_auth\n");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const lock = new DistributedLock({
        key: "k",
        host: "127.0.0.1",
        port,
        auth: "wrong-secret",
      });
      await assert.rejects(() => lock.acquire(), (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      });
      lock.close();
    } finally {
      await closeMockServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests (require a running dflockd on 127.0.0.1:6388)
// ---------------------------------------------------------------------------

describe("integration: acquire / release", () => {
  it("acquires and releases a lock", async () => {
    const lock = new DistributedLock({ key: "test-acq-rel" });
    const ok = await lock.acquire();
    assert.equal(ok, true);
    assert.ok(lock.token !== null);
    await lock.release();
    assert.equal(lock.token, null);
  });

  it("returns false on acquire timeout when lock is held", async () => {
    const holder = new DistributedLock({ key: "test-timeout" });
    assert.equal(await holder.acquire(), true);

    try {
      const waiter = new DistributedLock({
        key: "test-timeout",
        acquireTimeoutS: 1,
      });
      const ok = await waiter.acquire();
      assert.equal(ok, false);
    } finally {
      await holder.release();
    }
  });
});

describe("integration: withLock", () => {
  it("runs the callback and releases", async () => {
    const lock = new DistributedLock({ key: "test-withlock" });
    let ran = false;
    await lock.withLock(async () => {
      ran = true;
      assert.ok(lock.token !== null);
    });
    assert.equal(ran, true);
    assert.equal(lock.token, null);
  });

  it("releases even when the callback throws", async () => {
    const lock = new DistributedLock({ key: "test-withlock-throw" });
    await assert.rejects(
      () =>
        lock.withLock(async () => {
          throw new Error("boom");
        }),
      { message: "boom" },
    );
    assert.equal(lock.token, null);
  });

  it("throws AcquireTimeoutError when lock is held", async () => {
    const holder = new DistributedLock({ key: "test-withlock-timeout" });
    assert.equal(await holder.acquire(), true);

    try {
      const waiter = new DistributedLock({
        key: "test-withlock-timeout",
        acquireTimeoutS: 1,
      });
      await assert.rejects(
        () => waiter.withLock(async () => {}),
        (err: unknown) => err instanceof AcquireTimeoutError,
      );
    } finally {
      await holder.release();
    }
  });
});

describe("integration: enqueue / wait", () => {
  it("acquires immediately when lock is free", async () => {
    const lock = new DistributedLock({ key: "test-enq-free" });
    const status = await lock.enqueue();
    assert.equal(status, "acquired");
    assert.ok(lock.token !== null);

    // wait() should return true immediately (fast path)
    const ok = await lock.wait();
    assert.equal(ok, true);

    await lock.release();
  });

  it("queues and then grants the lock", async () => {
    const holder = new DistributedLock({ key: "test-enq-wait" });
    assert.equal(await holder.acquire(), true);

    const waiter = new DistributedLock({
      key: "test-enq-wait",
      acquireTimeoutS: 5,
    });
    const status = await waiter.enqueue();
    assert.equal(status, "queued");
    assert.equal(waiter.token, null);

    // Release holder so waiter can proceed
    setTimeout(() => holder.release(), 200);

    const ok = await waiter.wait(5);
    assert.equal(ok, true);
    assert.ok(waiter.token !== null);

    await waiter.release();
  });

  it("returns false on wait timeout", async () => {
    const holder = new DistributedLock({ key: "test-enq-timeout" });
    assert.equal(await holder.acquire(), true);

    try {
      const waiter = new DistributedLock({ key: "test-enq-timeout" });
      const status = await waiter.enqueue();
      assert.equal(status, "queued");

      const ok = await waiter.wait(1);
      assert.equal(ok, false);
    } finally {
      await holder.release();
    }
  });
});

// ---------------------------------------------------------------------------
// DistributedSemaphore constructor validation
// ---------------------------------------------------------------------------

describe("DistributedSemaphore constructor", () => {
  it("defaults to 127.0.0.1:6388 when no servers/host/port given", () => {
    const sem = new DistributedSemaphore({ key: "k", limit: 3 });
    assert.deepEqual(sem.servers, [["127.0.0.1", 6388]]);
  });

  it("accepts deprecated host/port and maps to servers", () => {
    const sem = new DistributedSemaphore({ key: "k", limit: 3, host: "10.0.0.1", port: 9999 });
    assert.deepEqual(sem.servers, [["10.0.0.1", 9999]]);
  });

  it("accepts a servers array", () => {
    const servers: Array<[string, number]> = [
      ["10.0.0.1", 6388],
      ["10.0.0.2", 6389],
    ];
    const sem = new DistributedSemaphore({ key: "k", limit: 3, servers });
    assert.deepEqual(sem.servers, servers);
  });

  it("throws on empty servers array", () => {
    assert.throws(
      () => new DistributedSemaphore({ key: "k", limit: 3, servers: [] }),
      LockError,
    );
  });

  it("uses stableHashShard by default", () => {
    const sem = new DistributedSemaphore({ key: "k", limit: 3 });
    assert.equal(sem.shardingStrategy, stableHashShard);
  });

  it("accepts a custom sharding strategy", () => {
    const custom = (_key: string, _n: number) => 0;
    const sem = new DistributedSemaphore({ key: "k", limit: 3, shardingStrategy: custom });
    assert.equal(sem.shardingStrategy, custom);
  });

  it("stores the limit", () => {
    const sem = new DistributedSemaphore({ key: "k", limit: 5 });
    assert.equal(sem.limit, 5);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — semaphore (require a running dflockd on 127.0.0.1:6388)
// ---------------------------------------------------------------------------

describe("integration: semaphore acquire / release", () => {
  it("acquires and releases a semaphore slot", async () => {
    const sem = new DistributedSemaphore({ key: "test-sem-acq-rel", limit: 3 });
    const ok = await sem.acquire();
    assert.equal(ok, true);
    assert.ok(sem.token !== null);
    await sem.release();
    assert.equal(sem.token, null);
  });

  it("allows multiple concurrent holders up to limit", async () => {
    const sems = Array.from({ length: 3 }, () =>
      new DistributedSemaphore({ key: "test-sem-multi", limit: 3 }),
    );

    for (const sem of sems) {
      assert.equal(await sem.acquire(), true);
    }

    // All three should be holding simultaneously
    for (const sem of sems) {
      assert.ok(sem.token !== null);
    }

    for (const sem of sems) {
      await sem.release();
    }
  });

  it("returns false on acquire timeout when all slots are held", async () => {
    const holders = Array.from({ length: 2 }, () =>
      new DistributedSemaphore({ key: "test-sem-timeout", limit: 2 }),
    );

    for (const h of holders) {
      assert.equal(await h.acquire(), true);
    }

    try {
      const waiter = new DistributedSemaphore({
        key: "test-sem-timeout",
        limit: 2,
        acquireTimeoutS: 1,
      });
      const ok = await waiter.acquire();
      assert.equal(ok, false);
    } finally {
      for (const h of holders) {
        await h.release();
      }
    }
  });
});

describe("integration: semaphore withLock", () => {
  it("runs the callback and releases", async () => {
    const sem = new DistributedSemaphore({ key: "test-sem-withlock", limit: 3 });
    let ran = false;
    await sem.withLock(async () => {
      ran = true;
      assert.ok(sem.token !== null);
    });
    assert.equal(ran, true);
    assert.equal(sem.token, null);
  });

  it("releases even when the callback throws", async () => {
    const sem = new DistributedSemaphore({ key: "test-sem-withlock-throw", limit: 3 });
    await assert.rejects(
      () =>
        sem.withLock(async () => {
          throw new Error("boom");
        }),
      { message: "boom" },
    );
    assert.equal(sem.token, null);
  });

  it("throws AcquireTimeoutError when all slots are held", async () => {
    const holders = Array.from({ length: 2 }, () =>
      new DistributedSemaphore({ key: "test-sem-withlock-timeout", limit: 2 }),
    );

    for (const h of holders) {
      assert.equal(await h.acquire(), true);
    }

    try {
      const waiter = new DistributedSemaphore({
        key: "test-sem-withlock-timeout",
        limit: 2,
        acquireTimeoutS: 1,
      });
      await assert.rejects(
        () => waiter.withLock(async () => {}),
        (err: unknown) => err instanceof AcquireTimeoutError,
      );
    } finally {
      for (const h of holders) {
        await h.release();
      }
    }
  });
});

describe("integration: semaphore enqueue / wait", () => {
  it("acquires immediately when slots are free", async () => {
    const sem = new DistributedSemaphore({ key: "test-sem-enq-free", limit: 3 });
    const status = await sem.enqueue();
    assert.equal(status, "acquired");
    assert.ok(sem.token !== null);

    const ok = await sem.wait();
    assert.equal(ok, true);

    await sem.release();
  });

  it("queues and then grants when a slot opens", async () => {
    const holders = Array.from({ length: 2 }, () =>
      new DistributedSemaphore({ key: "test-sem-enq-wait", limit: 2 }),
    );
    for (const h of holders) {
      assert.equal(await h.acquire(), true);
    }

    const waiter = new DistributedSemaphore({
      key: "test-sem-enq-wait",
      limit: 2,
      acquireTimeoutS: 5,
    });
    const status = await waiter.enqueue();
    assert.equal(status, "queued");
    assert.equal(waiter.token, null);

    // Release one holder so waiter can proceed
    setTimeout(() => holders[0].release(), 200);

    const ok = await waiter.wait(5);
    assert.equal(ok, true);
    assert.ok(waiter.token !== null);

    await waiter.release();
    await holders[1].release();
  });

  it("returns false on wait timeout", async () => {
    const holders = Array.from({ length: 2 }, () =>
      new DistributedSemaphore({ key: "test-sem-enq-timeout", limit: 2 }),
    );
    for (const h of holders) {
      assert.equal(await h.acquire(), true);
    }

    try {
      const waiter = new DistributedSemaphore({ key: "test-sem-enq-timeout", limit: 2 });
      const status = await waiter.enqueue();
      assert.equal(status, "queued");

      const ok = await waiter.wait(1);
      assert.equal(ok, false);
    } finally {
      for (const h of holders) {
        await h.release();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests — stats (require a running dflockd on 127.0.0.1:6388)
// ---------------------------------------------------------------------------

describe("integration: stats", () => {
  it("returns stats with expected shape", async () => {
    const s = await stats();
    assert.equal(typeof s.connections, "number");
    assert.ok(Array.isArray(s.locks));
    assert.ok(Array.isArray(s.semaphores));
    assert.ok(Array.isArray(s.idle_locks));
    assert.ok(Array.isArray(s.idle_semaphores));
  });

  it("reflects a held lock", async () => {
    const lock = new DistributedLock({ key: "test-stats-lock" });
    assert.equal(await lock.acquire(), true);

    try {
      const s = await stats();
      const entry = s.locks.find((l) => l.key === "test-stats-lock");
      assert.ok(entry, "held lock should appear in stats");
      assert.equal(typeof entry.owner_conn_id, "number");
      assert.equal(typeof entry.lease_expires_in_s, "number");
      assert.equal(typeof entry.waiters, "number");
    } finally {
      await lock.release();
    }
  });

  it("reflects a held semaphore", async () => {
    const sem = new DistributedSemaphore({ key: "test-stats-sem", limit: 3 });
    assert.equal(await sem.acquire(), true);

    try {
      const s = await stats();
      const entry = s.semaphores.find((e) => e.key === "test-stats-sem");
      assert.ok(entry, "held semaphore should appear in stats");
      assert.equal(entry.limit, 3);
      assert.equal(entry.holders, 1);
      assert.equal(typeof entry.waiters, "number");
    } finally {
      await sem.release();
    }
  });
});

describe("integration: sharding routes to correct server", () => {
  it("uses the sharding strategy to pick a server", async () => {
    // Custom strategy that always picks server index 1
    const lock = new DistributedLock({
      key: "test-shard-pick",
      servers: [
        ["192.0.2.1", 1111], // should NOT be picked
        ["127.0.0.1", 6388], // should be picked (index 1)
      ],
      shardingStrategy: () => 1,
    });

    const ok = await lock.acquire();
    assert.equal(ok, true);
    await lock.release();
  });

  it("fails when strategy routes to an unreachable server", async () => {
    const lock = new DistributedLock({
      key: "test-shard-fail",
      servers: [
        ["127.0.0.1", 1], // local port 1 — connection refused
        ["127.0.0.1", 6388],
      ],
      shardingStrategy: () => 0, // pick the unreachable one
      acquireTimeoutS: 1,
    });

    await assert.rejects(() => lock.acquire());
    lock.close();
  });
});

// ---------------------------------------------------------------------------
// Issue #7: Reuse of DistributedLock / DistributedSemaphore
// ---------------------------------------------------------------------------

describe("integration: lock reuse (issue #7)", () => {
  it("can acquire() twice on the same DistributedLock after release", async () => {
    const lock = new DistributedLock({ key: "test-reuse-lock" });

    const ok1 = await lock.acquire();
    assert.equal(ok1, true);
    await lock.release();

    // Second acquire after release should work fine (no force needed)
    const ok2 = await lock.acquire();
    assert.equal(ok2, true);
    await lock.release();
  });

  it("can acquire() twice on the same DistributedSemaphore after release", async () => {
    const sem = new DistributedSemaphore({ key: "test-reuse-sem", limit: 3 });

    const ok1 = await sem.acquire();
    assert.equal(ok1, true);
    await sem.release();

    const ok2 = await sem.acquire();
    assert.equal(ok2, true);
    await sem.release();
  });

  it("throws when acquire() called while already connected", async () => {
    const lock = new DistributedLock({ key: "test-reuse-throw", leaseTtlS: 2 });

    const ok = await lock.acquire();
    assert.equal(ok, true);

    await assert.rejects(() => lock.acquire(), LockError);
    await lock.release();
  });

  it("throws when enqueue() called while already connected", async () => {
    const lock = new DistributedLock({ key: "test-reuse-enq-throw", leaseTtlS: 2 });

    await lock.enqueue();

    await assert.rejects(() => lock.enqueue(), LockError);
    await lock.release();
  });

  it("acquire({ force: true }) closes previous connection", async () => {
    const lock = new DistributedLock({ key: "test-reuse-force", leaseTtlS: 2 });

    const ok1 = await lock.acquire();
    assert.equal(ok1, true);
    const token1 = lock.token;

    // Force acquire without releasing
    const ok2 = await lock.acquire({ force: true });
    assert.equal(ok2, true);
    assert.ok(lock.token !== token1, "should get a new token");
    await lock.release();
  });

  it("semaphore throws when acquire() called while already connected", async () => {
    const sem = new DistributedSemaphore({ key: "test-sem-reuse-throw", limit: 3 });

    const ok = await sem.acquire();
    assert.equal(ok, true);

    await assert.rejects(() => sem.acquire(), LockError);
    await sem.release();
  });

  it("semaphore acquire({ force: true }) closes previous connection", async () => {
    const sem = new DistributedSemaphore({ key: "test-sem-reuse-force", limit: 3 });

    const ok1 = await sem.acquire();
    assert.equal(ok1, true);

    const ok2 = await sem.acquire({ force: true });
    assert.equal(ok2, true);
    await sem.release();
  });
});
