import { environment, LaunchType, LocalStorage, showToast, Toast, updateCommandMetadata } from "@raycast/api";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createGitHubClient, resolveAccount } from "./lib/client";
import { checkTrackedRuns } from "./lib/monitor";
import { prepareNotifier, notifyRun } from "./lib/notifications";
import { github } from "./lib/oauth";
import { trackingPrefix } from "./lib/tracking";

export default async function Command() {
  // Keep manual/background launches from sending the same completion twice.
  await mkdir(environment.supportPath, { recursive: true });
  const lockPath = join(environment.supportPath, "watch-ci.lock");
  try {
    const lock = await stat(lockPath);
    if (Date.now() - lock.mtimeMs < 120_000) return;
    await unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lock = await open(lockPath, "wx").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") return undefined;
    throw error;
  });
  if (!lock) return;
  try {
    // Background scans must never open an OAuth sign-in dialog.
    const tokens = await github.client.getTokens();
    if (!tokens?.accessToken || tokens.isExpired()) {
      throw new Error("Open Recent CI to sign in to GitHub before monitoring runs.");
    }
    const signal = AbortSignal.timeout(45_000);
    const { client, cache } = createGitHubClient(tokens.accessToken);
    client.checkRetryDeadline();
    const accountId = await resolveAccount(tokens.accessToken, cache, client, signal);
    const prefix = trackingPrefix(accountId);
    const items = await LocalStorage.allItems();
    if (!Object.keys(items).some((key) => key.startsWith(prefix))) {
      await updateCommandMetadata({ subtitle: "No runs tracked · Track a run from Recent CI" });
      return;
    }
    const notifier = await prepareNotifier(environment.assetsPath);
    const result = await checkTrackedRuns({
      prefix,
      storage: LocalStorage,
      client,
      notify: (run) => notifyRun(run, notifier),
      signal,
    });
    if (result.errors.length) console.error(result.errors.join("\n"));
    const summary = `${result.checked}/${result.total} tracked runs checked · ${result.notified} notifications`;
    await updateCommandMetadata({
      subtitle: result.errors.length ? `${summary} · ${result.errors[0]}` : summary,
    });
    if (environment.launchType === LaunchType.UserInitiated) {
      await showToast({
        style: result.errors.length ? Toast.Style.Failure : Toast.Style.Success,
        title: result.errors.length ? "Some tracked runs could not be checked" : "Tracked runs checked",
        message: result.errors[0] ?? summary,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateCommandMetadata({ subtitle: message });
    if (environment.launchType === LaunchType.UserInitiated) {
      await showToast({ style: Toast.Style.Failure, title: "Unable to monitor CI", message });
    } else {
      console.error(message);
    }
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}
