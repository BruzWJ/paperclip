import { describe, expect, it, vi } from "vitest";
import {
  clearStaleChunkReloadFlag,
  recoverFromChunkLoadError,
  STALE_CHUNK_RELOAD_FLAG,
  type StaleChunkReloadStorage,
} from "./lazy-page";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const storage: StaleChunkReloadStorage & {
    dump: () => Record<string, string>;
  } = {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
  return storage;
}

describe("recoverFromChunkLoadError", () => {
  it("sets the guard flag and reloads once on the first chunk failure", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    const error = new Error("Failed to fetch dynamically imported module");

    const result = recoverFromChunkLoadError(error, storage, reload);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(STALE_CHUNK_RELOAD_FLAG)).toBe("1");
    expect(result).toBeInstanceOf(Promise);
  });

  it("returns a forever-pending promise while the reload takes over", async () => {
    const storage = memoryStorage();
    const result = recoverFromChunkLoadError(
      new Error("stale chunk"),
      storage,
      () => {},
    );

    const winner = await Promise.race([
      result.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    expect(winner).toBe("pending");
  });

  it("rethrows without reloading when the guard flag is already set", () => {
    const storage = memoryStorage({ [STALE_CHUNK_RELOAD_FLAG]: "1" });
    const reload = vi.fn();
    const error = new Error("chunk is genuinely broken");

    expect(() => recoverFromChunkLoadError(error, storage, reload)).toThrow(
      error,
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it("rethrows without reloading when storage is unavailable", () => {
    const reload = vi.fn();
    const error = new Error("import failed");

    expect(() => recoverFromChunkLoadError(error, null, reload)).toThrow(error);
    expect(reload).not.toHaveBeenCalled();
  });

  it("rethrows without reloading when storage access throws", () => {
    const reload = vi.fn();
    const error = new Error("import failed");
    const throwingStorage: StaleChunkReloadStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {
        throw new Error("storage disabled");
      },
    };

    expect(() =>
      recoverFromChunkLoadError(error, throwingStorage, reload),
    ).toThrow(error);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads on the first failure, then rethrows on the next one", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    const first = new Error("stale chunk");
    const second = new Error("still failing after reload");

    void recoverFromChunkLoadError(first, storage, reload);
    expect(reload).toHaveBeenCalledTimes(1);

    expect(() => recoverFromChunkLoadError(second, storage, reload)).toThrow(
      second,
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("clearStaleChunkReloadFlag", () => {
  it("removes the guard flag so a later redeploy can auto-recover again", () => {
    const storage = memoryStorage({ [STALE_CHUNK_RELOAD_FLAG]: "1" });

    clearStaleChunkReloadFlag(storage);

    expect(storage.getItem(STALE_CHUNK_RELOAD_FLAG)).toBeNull();
  });

  it("tolerates unavailable or throwing storage", () => {
    expect(() => clearStaleChunkReloadFlag(null)).not.toThrow();
    expect(() =>
      clearStaleChunkReloadFlag({
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {
          throw new Error("storage disabled");
        },
      }),
    ).not.toThrow();
  });
});
