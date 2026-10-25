import { createHash } from "node:crypto";
import { WorkflowRun, runStatus } from "./model";

export interface TrackedRun {
  subscription: string;
  run: WorkflowRun;
  baselineAttempt: number;
}

export interface RunState {
  run: WorkflowRun;
  notifiedAttempt: number;
}

export function tokenFingerprint(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function trackingPrefix(accountId: number) {
  return `ci-watch:account:${accountId}:`;
}

export function repositoriesKey(accountId: number) {
  return `tracked-repositories:account:${accountId}`;
}

// Only migrate keys for the authenticated token: other legacy keys may belong to another account.
export async function migrateAccountChoices(
  accountId: number,
  token: string,
  storage: {
    allItems(): Promise<Record<string, unknown>>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  },
) {
  const items = await storage.allItems();
  const fingerprint = tokenFingerprint(token);
  const legacyPrefix = `ci-watch:${fingerprint}:`;
  for (const [key, value] of Object.entries(items)) {
    const destination = key.startsWith(legacyPrefix)
      ? `${trackingPrefix(accountId)}${key.slice(legacyPrefix.length)}`
      : key === `tracked-repositories:${fingerprint}`
        ? repositoriesKey(accountId)
        : undefined;
    if (!destination || typeof value !== "string") continue;
    if (items[destination] === undefined) await storage.setItem(destination, value);
    await storage.removeItem(key);
  }
}

export function stateKey(watch: TrackedRun) {
  return `ci-watch-state:${watch.subscription}`;
}

export function shouldNotify(watch: TrackedRun, state: RunState | undefined, run: WorkflowRun): boolean {
  return (
    run.id === watch.run.id &&
    run.status === "completed" &&
    run.conclusion !== null &&
    run.run_attempt > Math.max(watch.baselineAttempt, state?.notifiedAttempt ?? 0)
  );
}

export function notificationFor(run: WorkflowRun) {
  const status = runStatus(run);
  const symbol = status.kind === "success" ? "🟢" : status.kind === "failure" ? "🔴" : "⚪";
  return {
    title: `${symbol} ${status.label} · ${run.repository.full_name}`,
    subtitle: `${run.name || "Workflow"} · ${run.head_branch || run.head_sha.slice(0, 7)}`,
    message: `${run.display_title || run.name || "Workflow run"} · ${run.head_sha.slice(0, 7)} · Attempt ${run.run_attempt}`,
    url: run.html_url,
    group: `github-ci-${run.id}-${run.run_attempt}`,
  };
}

export function parseStored<T>(value: unknown): T | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
