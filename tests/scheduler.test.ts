import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";
import { Scheduler, SettingsError } from "@/server/sync/scheduler";
import { SyncService } from "@/server/sync/sync-service";
import { BASE, FakeFetcher, body, fakeExtract, testConfig, type Route } from "./helpers";

const HOME = `${BASE}/docs`;
const MIN = 60_000;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

const site = (): Record<string, Route> => ({
  [HOME]: { html: body({ title: "Home", text: "Welcome home text", links: ["/docs/a"] }), etag: "h" },
  [`${BASE}/docs/a`]: { html: body({ title: "A", text: "Alpha body text" }), etag: "a" },
});

function env(repo = new Repository(openDatabase(":memory:")), tickMs = 15_000) {
  const clock = { now: T0 };
  const fetcher = new FakeFetcher(site());
  const service = new SyncService({
    repo,
    config: testConfig(),
    createFetcher: () => fetcher,
    loadRobots: async () => null,
    extract: fakeExtract,
    sleep: async () => {},
    now: () => new Date(clock.now),
  });
  const scheduler = new Scheduler({ repo, service, now: () => new Date(clock.now), tickMs });
  return { repo, clock, fetcher, service, scheduler };
}

const iso = (ms: number) => new Date(ms).toISOString();

describe("scheduler: schedule and automatic runs", () => {
  it("is off by default and never starts a sync on its own", () => {
    const t = env();
    assert.deepEqual(t.scheduler.getSettings(), { autoEnabled: false, intervalMinutes: 60, schedulePaused: false });
    t.clock.now += 10 * 60 * MIN;
    t.scheduler.tick();
    assert.equal(t.service.isBusy(), false);
    assert.equal(t.repo.listRuns().length, 0);
    assert.equal(t.scheduler.getStatus().nextRunAt, null);
  });

  it("schedules the next run one interval ahead, runs when due, then re-arms after the run", async () => {
    const t = env();
    t.scheduler.updateSettings({ autoEnabled: true, intervalMinutes: 15 });
    assert.equal(t.scheduler.getStatus().nextRunAt, iso(T0 + 15 * MIN));

    t.clock.now = T0 + 14 * MIN;
    t.scheduler.tick();
    assert.equal(t.repo.listRuns().length, 0, "not due yet");

    t.clock.now = T0 + 15 * MIN;
    t.scheduler.tick();
    assert.equal(t.service.isBusy(), true, "a scheduled run started");
    assert.equal(t.scheduler.getStatus().nextRunAt, null, "no next time is claimed while a run is active");
    await t.service.whenIdle();

    const run = t.repo.getLastRun();
    assert.equal(run?.trigger, "scheduled");
    assert.equal(run?.mode, "full", "first scheduled run is a full sync");
    assert.equal(run?.status, "completed");
    assert.equal(t.scheduler.getStatus().nextRunAt, iso(T0 + 30 * MIN), "re-armed one interval after the run finished");
    assert.equal(t.scheduler.getStatus().lastScheduledRunAt, iso(T0 + 15 * MIN));

    t.clock.now = T0 + 30 * MIN;
    t.scheduler.tick();
    await t.service.whenIdle();
    assert.equal(t.repo.getLastRun()?.mode, "incremental", "later scheduled runs are incremental");
    assert.equal(t.repo.listRuns().length, 2);
  });

  it("never stacks a scheduled run on top of one that is still active", async () => {
    const t = env();
    t.scheduler.updateSettings({ autoEnabled: true, intervalMinutes: 15 });
    assert.ok(t.service.start("full", "manual").ok);
    t.service.pause(); // the run stays open (paused) while the schedule falls due

    t.clock.now = T0 + 20 * MIN;
    t.scheduler.tick();
    assert.equal(t.repo.listRuns().length, 1, "no second run was started");

    t.service.cancel();
    await t.service.whenIdle();
    assert.equal(t.scheduler.getStatus().nextRunAt, iso(T0 + 35 * MIN), "re-armed after the active run ended");
  });

  it("pausing the schedule stops scheduled runs; resuming re-arms it", () => {
    const t = env();
    t.scheduler.updateSettings({ autoEnabled: true, intervalMinutes: 15 });
    t.scheduler.updateSettings({ schedulePaused: true });
    assert.equal(t.scheduler.getStatus().nextRunAt, null);
    assert.equal(t.scheduler.getStatus().schedulePaused, true);

    t.clock.now = T0 + 5 * 60 * MIN;
    t.scheduler.tick();
    assert.equal(t.repo.listRuns().length, 0, "nothing runs while the schedule is paused");

    t.scheduler.updateSettings({ schedulePaused: false });
    assert.equal(t.scheduler.getStatus().nextRunAt, iso(t.clock.now + 15 * MIN));
  });

  it("turning automatic sync off clears the next run time", () => {
    const t = env();
    t.scheduler.updateSettings({ autoEnabled: true });
    assert.ok(t.scheduler.getStatus().nextRunAt);
    t.scheduler.updateSettings({ autoEnabled: false });
    assert.equal(t.scheduler.getStatus().nextRunAt, null);
  });

  it("changing the interval re-computes the next run", () => {
    const t = env();
    t.scheduler.updateSettings({ autoEnabled: true, intervalMinutes: 60 });
    t.clock.now = T0 + 10 * MIN;
    t.scheduler.updateSettings({ intervalMinutes: 30 });
    assert.equal(t.scheduler.getStatus().nextRunAt, iso(T0 + 40 * MIN));
  });

  it("a manual run postpones the next scheduled run", async () => {
    const t = env();
    t.scheduler.updateSettings({ autoEnabled: true, intervalMinutes: 15 });
    t.clock.now = T0 + 10 * MIN;
    t.service.start("full", "manual");
    await t.service.whenIdle();
    assert.equal(t.scheduler.getStatus().nextRunAt, iso(T0 + 25 * MIN));
  });
});

describe("scheduler: settings validation and persistence", () => {
  it("rejects invalid intervals and flags, leaving settings unchanged", () => {
    const t = env();
    for (const bad of [4, 1.5, 10_081, Number.NaN, "30" as unknown as number]) {
      assert.throws(() => t.scheduler.updateSettings({ intervalMinutes: bad }), SettingsError, String(bad));
    }
    assert.throws(() => t.scheduler.updateSettings({ autoEnabled: "yes" as unknown as boolean }), SettingsError);
    assert.equal(t.scheduler.getSettings().intervalMinutes, 60);
  });

  it("settings and the next run time survive a backend restart", () => {
    const t = env();
    t.scheduler.updateSettings({ autoEnabled: true, intervalMinutes: 30 });
    const restarted = env(t.repo);
    assert.deepEqual(restarted.scheduler.getSettings(), { autoEnabled: true, intervalMinutes: 30, schedulePaused: false });
    assert.equal(restarted.scheduler.getStatus().nextRunAt, iso(T0 + 30 * MIN));
  });
});

describe("scheduler: honest status (heartbeat and downtime)", () => {
  it("reports not running before start, running and healthy after, not running after stop", () => {
    const t = env(undefined, 60_000_000);
    assert.deepEqual([t.scheduler.getStatus().running, t.scheduler.getStatus().healthy], [false, false]);
    t.scheduler.start();
    try {
      t.scheduler.start(); // idempotent: still a single timer
      const status = t.scheduler.getStatus();
      assert.deepEqual([status.running, status.healthy], [true, true]);
      assert.equal(status.heartbeatAt, iso(T0));
    } finally {
      t.scheduler.stop();
    }
    assert.deepEqual([t.scheduler.getStatus().running, t.scheduler.getStatus().healthy], [false, false]);
  });

  it("stops claiming to be healthy when the heartbeat goes stale", () => {
    const t = env(undefined, 1000);
    t.scheduler.start();
    try {
      t.clock.now += 10_000; // ten ticks without a heartbeat
      const status = t.scheduler.getStatus();
      assert.equal(status.running, true);
      assert.equal(status.healthy, false);
    } finally {
      t.scheduler.stop();
    }
  });

  it("tells the user when a scheduled run came due while the backend was not running", async () => {
    const first = env();
    first.scheduler.updateSettings({ autoEnabled: true, intervalMinutes: 15 });

    // The backend stops for two hours, then starts again.
    const second = env(first.repo, 1000);
    second.clock.now = T0 + 120 * MIN;
    second.scheduler.start();
    try {
      assert.match(second.scheduler.getStatus().downtimeNotice ?? "", /due at .* but the backend was not running/);
      assert.equal(second.service.isBusy(), true, "the overdue run starts as soon as the backend is back");
      assert.ok(first.repo.getLogs().some((l) => l.level === "warn" && /not running/.test(l.message)));
      await second.service.whenIdle();
      assert.equal(second.scheduler.getStatus().downtimeNotice, null, "notice is cleared once the run finished");
      assert.equal(first.repo.getLastRun()?.trigger, "scheduled");
    } finally {
      second.scheduler.stop();
    }
  });
});
