import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  DistributedLock,
  DistributedSemaphore,
  AcquireTimeoutError,
  LockError,
  stableHashShard,
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
    await lock.close();
  });
});
