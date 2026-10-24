import { Cache } from "@raycast/api";
import { createHash } from "node:crypto";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitHubClient } from "./github";
import { recentRuns, Repository, Snapshot } from "./model";

function readCache<T>(cache: Cache, key: string): T | undefined {
  try {
    const value = cache.get(key);
    return value ? (JSON.parse(value) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function useRecentCI(token: string, lookback: number) {
  const cache = useMemo(() => new Cache({ namespace: createHash("sha256").update(token).digest("hex") }), [token]);
  const key = `runs:${lookback}`;
  const client = useMemo(
    () =>
      new GitHubClient(token, fetch, {
        get: () => readCache<{ repositories: Repository[]; savedAt: number }>(cache, "repositories"),
        set: (value) => cache.set("repositories", JSON.stringify(value)),
      }),
    [token, cache],
  );
  const [snapshot, setSnapshot] = useState<Snapshot>(() => {
    const saved = readCache<Snapshot>(cache, key);
    return saved
      ? { ...saved, runs: recentRuns(saved.runs, Date.now() - lookback) }
      : { runs: [], issues: [], checked: 0, total: 0 };
  });
  const latest = useRef(snapshot);
  const [loading, setLoading] = useState(true);
  const [cached, setCached] = useState(true);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  const refresh = useCallback(
    async (forceDiscovery = false) => {
      if (active.current || !mounted.current) return;
      const controller = new AbortController();
      active.current = controller;
      setLoading(true);
      const update = (next: Snapshot) => {
        if (!controller.signal.aborted && mounted.current) {
          latest.current = next;
          setSnapshot(next);
        }
      };
      try {
        const next = await client.scan({
          lookback,
          previous: latest.current.runs,
          signal: controller.signal,
          forceDiscovery,
          onProgress: update,
        });
        update(next);
        if (!controller.signal.aborted && mounted.current) {
          cache.set(key, JSON.stringify(next));
          setCached(false);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          update({
            ...latest.current,
            runs: recentRuns(latest.current.runs, Date.now() - lookback),
            checked: 0,
            issues: [{ message: error instanceof Error ? error.message : "Unable to refresh GitHub. Try again." }],
          });
          setCached(true);
        }
      } finally {
        if (active.current === controller) {
          active.current = null;
          if (mounted.current) setLoading(false);
        }
      }
    },
    [client, cache, key, lookback],
  );

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      active.current?.abort();
      active.current = null;
    };
  }, [refresh]);

  return { snapshot, loading, cached, refresh };
}
