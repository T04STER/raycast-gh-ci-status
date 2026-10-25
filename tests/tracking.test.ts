import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubError } from "../src/lib/github";
import { checkTrackedRuns, WatchStorage } from "../src/lib/monitor";
import { WorkflowRun } from "../src/lib/model";
import {
  migrateAccountChoices,
  notificationFor,
  repositoriesKey,
  RunState,
  shouldNotify,
  stateKey,
  tokenFingerprint,
  TrackedRun,
  trackingPrefix,
} from "../src/lib/tracking";

const run: WorkflowRun = {
  id: 42,
  name: "Tests",
  display_title: "Fix login redirect",
  head_branch: "main",
  head_sha: "abcdef123456",
  html_url: "https://github.com/owner/repo/actions/runs/42",
  status: "in_progress",
  conclusion: null,
  created_at: "2020-01-01T00:00:00Z",
  updated_at: "2020-01-01T00:00:00Z",
  run_attempt: 1,
  repository: { id: 1, full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
  pull_requests: [],
};
const watch: TrackedRun = { subscription: "subscription-1", run, baselineAttempt: 0 };
const key = "test:42";
const completed = (conclusion = "success", attempt = 1): WorkflowRun => ({
  ...run,
  status: "completed",
  conclusion,
  run_attempt: attempt,
});

function fixture(watches: Record<string, string> = { [key]: JSON.stringify(watch) }) {
  const values: Record<string, string> = { ...watches };
  const storage: WatchStorage = {
    allItems: async () => ({ ...values }),
    getItem: async (key) => values[key],
    setItem: async (key, value) => {
      values[key] = value;
    },
  };
  const sent: WorkflowRun[] = [];
  const check = (
    options: {
      fetch?: () => Promise<WorkflowRun>;
      notify?: (run: WorkflowRun) => Promise<void>;
    } = {},
  ) =>
    checkTrackedRuns({
      prefix: "test:",
      storage,
      client: { run: options.fetch ?? (async () => completed()) },
      notify:
        options.notify ??
        (async (run) => {
          sent.push(run);
        }),
      signal: new AbortController().signal,
    });
  return { values, sent, check };
}

test("all terminal outcomes notify once, including runs outside the lookback", async () => {
  for (const conclusion of ["success", "failure", "cancelled", "timed_out", "skipped"]) {
    const { check, sent } = fixture();
    await check({ fetch: async () => completed(conclusion) });
    await check({ fetch: async () => completed(conclusion) });
    assert.equal(sent.length, 1, conclusion);
    assert.equal(sent[0].conclusion, conclusion);
  }
});

test("running and incomplete results do not notify; a later completion does", async () => {
  const { check, sent } = fixture();
  await check({ fetch: async () => run });
  await check({ fetch: async () => ({ ...completed(), conclusion: null }) });
  assert.equal(sent.length, 0);
  await check();
  assert.equal(sent.length, 1);
});

test("a previously saved completion baseline is respected; reruns notify once", async () => {
  const { check, sent } = fixture({ [key]: JSON.stringify({ ...watch, baselineAttempt: 1 }) });
  await check();
  assert.equal(sent.length, 0);
  await check({ fetch: async () => ({ ...run, run_attempt: 2 }) });
  await check({ fetch: async () => completed("failure", 2) });
  await check({ fetch: async () => completed("failure", 2) });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].run_attempt, 2);
});

test("untracking during a scan prevents notification and does not recreate saved state", async () => {
  const { values, check, sent } = fixture();
  await check({
    fetch: async () => {
      delete values[key];
      return completed();
    },
  });
  assert.equal(sent.length, 0);
  assert.equal(values[stateKey(watch)], undefined);
});

test("retracking during a scan does not send the old subscription's notification", async () => {
  const { values, check, sent } = fixture();
  await check({
    fetch: async () => {
      values[key] = JSON.stringify({ ...watch, subscription: "replacement" });
      return completed();
    },
  });
  assert.equal(sent.length, 0);
  assert.equal(values[stateKey(watch)], undefined);
});

test("notification errors preserve delivery state and retry on the next scan", async () => {
  const { values, check, sent } = fixture();
  const failed = await check({
    notify: async () => {
      throw new Error("Notification permission denied");
    },
  });
  assert.match(failed.errors[0], /permission denied/);
  assert.equal(values[stateKey(watch)], undefined);
  await check();
  assert.equal(sent.length, 1);
});

test("API failures do not notify or erase state", async () => {
  const { values, check, sent } = fixture();
  await check({ fetch: async () => run });
  const saved = values[stateKey(watch)];
  const failed = await check({
    fetch: async () => {
      throw new GitHubError("Revoked", 401, true);
    },
  });
  assert.equal(failed.errors.length, 1);
  assert.equal(sent.length, 0);
  assert.equal(values[stateKey(watch)], saved);
});

test("notification text includes workflow, repository, branch, result and a direct run link", () => {
  const notification = notificationFor(completed("failure"));
  assert.match(notification.title, /failure.*owner\/repo/i);
  assert.match(notification.subtitle, /Tests.*main/);
  assert.match(notification.message, /Fix login redirect.*abcdef1/);
  assert.equal(notification.url, run.html_url);
});

test("delivery state cannot suppress a newer attempt or notify a different run", () => {
  const state: RunState = { run: completed(), notifiedAttempt: 1 };
  assert.equal(shouldNotify(watch, state, completed()), false);
  assert.equal(shouldNotify(watch, state, completed("success", 2)), true);
  assert.equal(shouldNotify(watch, state, { ...completed("success", 2), id: 99 }), false);
});

test("saved choices follow the account across token replacement and remain isolated from other accounts", async () => {
  const accountId = 123;
  const oldToken = "old-token";
  const newToken = "replacement-token";
  const legacyKey = `ci-watch:${tokenFingerprint(oldToken)}:42`;
  const legacyRepos = `tracked-repositories:${tokenFingerprint(oldToken)}`;
  const otherKey = `ci-watch:${tokenFingerprint("other-account-token")}:42`;
  const { values } = fixture({
    [legacyKey]: JSON.stringify(watch),
    [legacyRepos]: JSON.stringify([run.repository]),
    [otherKey]: JSON.stringify(watch),
    [stateKey(watch)]: JSON.stringify({ run: completed(), notifiedAttempt: 1 }),
  });
  const storage = {
    allItems: async () => ({ ...values }),
    setItem: async (key: string, value: string) => {
      values[key] = value;
    },
    removeItem: async (key: string) => {
      delete values[key];
    },
  };
  await migrateAccountChoices(accountId, oldToken, storage);
  await migrateAccountChoices(accountId, newToken, storage);
  assert.equal(values[`${trackingPrefix(accountId)}42`], JSON.stringify(watch));
  assert.equal(values[repositoriesKey(accountId)], JSON.stringify([run.repository]));
  assert.ok(values[stateKey(watch)]);
  assert.equal(values[legacyKey], undefined);
  assert.equal(values[legacyRepos], undefined);
  assert.ok(values[otherKey]);
  assert.equal(values[`${trackingPrefix(456)}42`], undefined);
});

test("legacy choices do not overwrite newer account choices", async () => {
  const { values } = fixture({
    [`tracked-repositories:${tokenFingerprint("token")}`]: JSON.stringify([run.repository]),
    [repositoriesKey(123)]: "[]",
  });
  await migrateAccountChoices(123, "token", {
    allItems: async () => values,
    setItem: async (key, value) => {
      values[key] = value;
    },
    removeItem: async (key) => {
      delete values[key];
    },
  });
  assert.equal(values[repositoriesKey(123)], "[]");
});

test("interrupted scans resume beyond slow watches, even after the continuation watch is removed", async () => {
  const watches = Object.fromEntries(
    Array.from({ length: 13 }, (_, index) => {
      const id = index + 1;
      return [
        `test:${String(id).padStart(2, "0")}`,
        JSON.stringify({ ...watch, subscription: `sub-${id}`, run: { ...run, id } }),
      ];
    }),
  );
  const { values } = fixture(watches);
  const storage: WatchStorage = {
    allItems: async () => ({ ...values }),
    getItem: async (key) => values[key],
    setItem: async (key, value) => {
      values[key] = value;
    },
  };
  const attempted: number[] = [];
  const controller = new AbortController();
  await checkTrackedRuns({
    prefix: "test:",
    storage,
    signal: controller.signal,
    notify: async () => {},
    client: {
      run: async (_, id) => {
        attempted.push(id);
        if (attempted.length === 12) controller.abort();
        throw new Error("Request timed out");
      },
    },
  });
  assert.equal(attempted.length, 12);
  const sent: number[] = [];
  await checkTrackedRuns({
    prefix: "test:",
    storage,
    signal: new AbortController().signal,
    notify: async (run) => {
      sent.push(run.id);
    },
    client: { run: async (_, id) => ({ ...completed(), id }) },
  });
  assert.equal(sent[0], 13);
  // The saved continuation points at 13. A removed watch must not reset the queue.
  delete values["test:13"];
  attempted.length = 0;
  const stop = new AbortController();
  await checkTrackedRuns({
    prefix: "test:",
    storage,
    signal: stop.signal,
    notify: async () => {},
    client: {
      run: async (_, id) => {
        attempted.push(id);
        stop.abort();
        throw new Error("Request timed out");
      },
    },
  });
  assert.equal(attempted[0], 1);
});
