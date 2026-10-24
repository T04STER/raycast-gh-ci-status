# GitHub CI Status

One Raycast command, **Recent CI**, showing recent GitHub Actions runs across repositories accessible to your GitHub OAuth sign-in.

## Run locally

Requires Node.js 22.22.2+ and Raycast on macOS.

```sh
npm install
npm run dev
```

Open **Recent CI** in Raycast and sign in through GitHub. No PAT or custom OAuth app is needed. Private repositories require the OAuth `repo` scope; organization policies may require approval for Raycast's OAuth app.

## Use

- The rolling lookback defaults to **1h**. Change **Lookback Period** in the extension's native preferences; supported durations include `30m`, `1h`, and `2d`.
- Passed runs are green, failures red, and queued/running runs yellow. Cancelled/skipped results have separate labels.
- **Enter** opens the selected workflow run on GitHub.
- **⌘R** refreshes results and repository discovery.
- Results refresh every 30 seconds while the command is open. Closing it stops polling.
- Search by repository, workflow, branch, status, or commit SHA.

The time filter uses run creation time. Runs created before the cutoff are excluded even if still running. This version covers GitHub Actions only.

Repository discovery is cached for 15 minutes. Scans use four concurrent workers, pagination, request timeouts, and rate-limit handling. Partial failures are displayed; cached results are marked as potentially stale. GitHub limits filtered searches to 1,000 runs per repository, which produces a warning if reached.

## Checks

```sh
npm test
npm run typecheck
npm run lint
npm run build
```
