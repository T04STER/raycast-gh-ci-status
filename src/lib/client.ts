import { Cache, LocalStorage } from "@raycast/api";
import { GitHubClient } from "./github";
import { Repository } from "./model";
import { migrateAccountChoices, tokenFingerprint } from "./tracking";

export function readCache<T>(cache: Cache, key: string): T | undefined {
  try {
    const value = cache.get(key);
    return value ? (JSON.parse(value) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function createGitHubClient(token: string) {
  const cache = new Cache({ namespace: tokenFingerprint(token) });
  const client = new GitHubClient(
    token,
    fetch,
    {
      get: () => readCache<{ repositories: Repository[]; savedAt: number }>(cache, "repositories"),
      set: (value) => cache.set("repositories", JSON.stringify(value)),
    },
    {
      get: () => readCache<number>(cache, "retry-after"),
      set: (deadline) => cache.set("retry-after", JSON.stringify(deadline)),
    },
  );
  return { cache, client };
}

export async function resolveAccount(token: string, cache: Cache, client: GitHubClient, signal: AbortSignal) {
  let id = readCache<number>(cache, "account-id");
  if (!id || !Number.isSafeInteger(id) || id <= 0) {
    id = await client.accountId(signal);
    cache.set("account-id", JSON.stringify(id));
  }
  await migrateAccountChoices(id, token, LocalStorage);
  return id;
}
