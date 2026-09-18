import assert from "node:assert/strict";
import test from "node:test";
import { createNativeSaveScheduler } from "../packages/obsidian-plugin/src/editor/native-save-scheduler";

interface FakeTimer {
  readonly handle: ReturnType<typeof setTimeout>;
  readonly callback: () => void;
  readonly delayMs: number;
}

function createFakeTimers() {
  const timers: FakeTimer[] = [];
  let cancelled = 0;
  let sequence = 0;
  return {
    timers,
    get cancelled() {
      return cancelled;
    },
    setTimer: (callback: () => void, delayMs: number) => {
      sequence += 1;
      const handle = sequence as unknown as ReturnType<typeof setTimeout>;
      timers.push({ handle, callback, delayMs });
      return handle;
    },
    clearTimer: () => {
      cancelled += 1;
    },
  };
}

test("rapid edits coalesce into a single deferred write", () => {
  // Given: a scheduler that records the writes it performs.
  const fake = createFakeTimers();
  const writes: number[] = [];
  const scheduler = createNativeSaveScheduler({
    delayMs: 2000,
    persist: async () => {
      writes.push(Date.now());
    },
    setTimer: fake.setTimer,
    clearTimer: fake.clearTimer,
  });

  // When: many edits arrive in quick succession.
  for (let index = 0; index < 20; index += 1) scheduler.schedule();

  // Then: nothing is written yet, and exactly one timer is outstanding.
  assert.equal(writes.length, 0);
  assert.equal(scheduler.hasPending(), true);
  assert.equal(fake.timers.length, 20);
  assert.equal(fake.cancelled, 19);

  // And when the last timer fires, exactly one write happens.
  fake.timers[fake.timers.length - 1]?.callback();
  assert.equal(writes.length, 1);
  assert.equal(scheduler.hasPending(), false);
});

test("a pending edit flushes immediately when the pane closes", async () => {
  // Given: a scheduled but not yet performed write.
  const fake = createFakeTimers();
  let writes = 0;
  const scheduler = createNativeSaveScheduler({
    delayMs: 2000,
    persist: async () => {
      writes += 1;
    },
    setTimer: fake.setTimer,
    clearTimer: fake.clearTimer,
  });
  scheduler.schedule();
  assert.equal(writes, 0);

  // When: the pane closes before the delay elapses.
  await scheduler.flush();

  // Then: the edit is written rather than dropped.
  assert.equal(writes, 1);
  assert.equal(scheduler.hasPending(), false);
});

test("flush and cancel are no-ops when nothing is pending", async () => {
  const fake = createFakeTimers();
  let writes = 0;
  const scheduler = createNativeSaveScheduler({
    delayMs: 2000,
    persist: async () => {
      writes += 1;
    },
    setTimer: fake.setTimer,
    clearTimer: fake.clearTimer,
  });

  await scheduler.flush();
  scheduler.cancel();

  assert.equal(writes, 0);
  assert.equal(scheduler.hasPending(), false);
});

test("a timer that already fired does not write again on flush", async () => {
  // Given: an edit whose debounce window already elapsed.
  const fake = createFakeTimers();
  let writes = 0;
  const scheduler = createNativeSaveScheduler({
    delayMs: 2000,
    persist: async () => {
      writes += 1;
    },
    setTimer: fake.setTimer,
    clearTimer: fake.clearTimer,
  });
  scheduler.schedule();
  fake.timers[0]?.callback();
  assert.equal(writes, 1);

  // When: flush runs afterwards.
  await scheduler.flush();

  // Then: no duplicate write is produced.
  assert.equal(writes, 1);
});
