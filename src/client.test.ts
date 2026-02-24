import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  DistributedLock,
  DistributedSemaphore,
  AcquireTimeoutError,
  AuthError,
  LockError,
  stableHashShard,
  stats,
} from "./client.js";

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
