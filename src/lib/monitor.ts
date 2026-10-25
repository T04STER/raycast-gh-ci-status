import { GitHubClient, GitHubError } from "./github";
import { WorkflowRun } from "./model";
import { parseStored, RunState, shouldNotify, stateKey, TrackedRun } from "./tracking";

export interface WatchStorage {
  allItems(): Promise<Record<string, unknown>>;
  getItem(key: string): Promise<unknown>;
  setItem(key: string, value: string): Promise<void>;
}

export async function checkTrackedRuns(options: {
  prefix: string;
  storage: WatchStorage;
  client: Pick<GitHubClient, "run">;
  notify: (run: WorkflowRun) => Promise<void>;
  signal: AbortSignal;
}) {
  const { prefix, storage, client, notify, signal } = options;
  const continuationKey = `ci-watch-continuation:${prefix}`;
  const entries = Object.entries(await storage.allItems())
    .filter(([key]) => key.startsWith(prefix))
    .flatMap(([key, value]) => {
      const watch = parseStored<TrackedRun>(value);
      return watch?.subscription && watch.run?.id ? [{ key, watch }] : [];
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  const nextKey = await storage.getItem(continuationKey);
  const start = typeof nextKey === "string" ? entries.findIndex(({ key }) => key.localeCompare(nextKey) >= 0) : 0;
  if (start > 0) entries.push(...entries.splice(0, start));
  const errors: string[] = [];
  let cursor = 0;
  let checked = 0;
  let notified = 0;
  let stopped = false;
  const worker = async () => {
    while (!signal.aborted && !stopped && cursor < entries.length) {
      const { key, watch } = entries[cursor++];
      try {
        const run = await client.run(watch.run.repository, watch.run.id, signal);
        const current = parseStored<TrackedRun>(await storage.getItem(key));
        // An untrack/retrack during the network request must not revive the old subscription.
        if (current?.subscription !== watch.subscription) continue;
        const previous = parseStored<RunState>(await storage.getItem(stateKey(watch)));
        const send = shouldNotify(watch, previous, run);
        signal.throwIfAborted();
        if (send) {
          await notify(run);
          notified++;
        }
        const stillTracked = parseStored<TrackedRun>(await storage.getItem(key));
        if (stillTracked?.subscription === watch.subscription) {
          await storage.setItem(
            stateKey(watch),
            JSON.stringify({
              run,
              notifiedAttempt: send ? run.run_attempt : (previous?.notifiedAttempt ?? watch.baselineAttempt),
            } satisfies RunState),
          );
        }
        checked++;
      } catch (error) {
        errors.push(`${watch.run.repository.full_name}: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof GitHubError && error.stopScan) stopped = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, worker));
  // Advance past attempted requests even when they time out. Persist a key rather than
  // an index so removing or adding watches does not reset progress.
  if (cursor > 0) await storage.setItem(continuationKey, entries[cursor % entries.length].key);
  if (signal.aborted && !errors.length) errors.push("The scan timed out; remaining runs will be checked next time.");
  return { checked, notified, total: entries.length, errors };
}
