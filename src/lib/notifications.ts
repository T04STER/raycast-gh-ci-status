import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { notificationFor } from "./tracking";
import { WorkflowRun } from "./model";

const execute = promisify(execFile);

export async function findNotifier(): Promise<string> {
  for (const path of ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"]) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Raycast's PATH may not include Homebrew, so check both installation locations.
    }
  }
  throw new Error("Install terminal-notifier with: brew install terminal-notifier. Then try tracking again.");
}

export async function notifyRun(run: WorkflowRun, notifier: string): Promise<void> {
  const notification = notificationFor(run);
  const url = new URL(notification.url);
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error("The workflow run did not return a valid GitHub URL.");
  }
  // terminal-notifier parses arguments as property lists. Prefixing text with a space
  // prevents a commit title starting with [, {, or quotes from being parsed as one.
  try {
    await execute(
      notifier,
      [
        "-title",
        ` ${notification.title}`,
        "-subtitle",
        ` ${notification.subtitle}`,
        "-message",
        ` ${notification.message}`,
        "-open",
        url.href,
        "-group",
        notification.group,
        "-sound",
        "default",
      ],
      { timeout: 10_000 },
    );
  } catch (error) {
    const failure = error as Error & { code?: number; stderr?: string };
    if (failure.code === 3 || /not allowed|not authorized|permission/i.test(failure.stderr ?? "")) {
      throw new Error(
        "Allow notifications for terminal-notifier in macOS System Settings → Notifications, then run Watch CI Notifications again.",
      );
    }
    throw new Error(`Unable to send the CI notification: ${failure.stderr?.trim() || failure.message}`);
  }
}
