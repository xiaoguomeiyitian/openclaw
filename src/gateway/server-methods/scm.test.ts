// scm source-control handler tests: porcelain status parsing, authorization
// rejection, and the commit happy path. git execution is mocked so the tests
// assert handler logic without spawning a real repository.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scmHandlers } from "./scm.js";

type GitResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  termination: "exit" | "timeout" | "no-output-timeout" | "signal";
  stdoutTruncatedBytes?: number;
  outputLimitExceeded?: boolean;
};

const hoisted = vi.hoisted(() => ({
  runGit: vi.fn(),
  resolveAuthorizedRepoRoot: vi.fn(),
}));

vi.mock("../../agents/worktrees/git.js", () => ({
  runGit: hoisted.runGit,
}));

vi.mock("./worktrees.js", () => ({
  resolveAuthorizedRepoRoot: hoisted.resolveAuthorizedRepoRoot,
}));

function okResult(stdout: string): GitResult {
  return { stdout, stderr: "", code: 0, termination: "exit" };
}

function errorResult(stderr: string): GitResult {
  return { stdout: "", stderr, code: 1, termination: "exit" };
}

function createResponder() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  return {
    calls,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
  };
}

async function invokeScm(method: string, params: Record<string, unknown>) {
  const responder = createResponder();
  const handler = scmHandlers[method as keyof typeof scmHandlers];
  if (!handler) {
    throw new Error(`no handler: ${method}`);
  }
  await handler({
    req: { type: "req", id: method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: responder.respond,
    context: { getRuntimeConfig: () => ({}) } as never,
  } as never);
  return responder.calls;
}

describe("scm RPC handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resolveAuthorizedRepoRoot.mockImplementation((_method, repoRoot) => repoRoot);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("scm.status porcelain parsing", () => {
    it("splits staged, unstaged, untracked, and rename entries into groups", async () => {
      // porcelain=v1 -z records: staged modified, unstaged modified, added,
      // untracked, and a rename (old -> new).
      const porcelain = [
        "M  src/staged.ts",
        " M src/unstaged.ts",
        "A  src/added.ts",
        "?? src/untracked.ts",
        "R  src/old.ts -> src/new.ts",
      ].join("\0");
      hoisted.runGit.mockResolvedValue(okResult(porcelain));
      hoisted.resolveAuthorizedRepoRoot.mockImplementation((_m, r) => r);

      const calls = await invokeScm("scm.status", { repoRoot: "/repo" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ok).toBe(true);
      const payload = calls[0]?.payload as {
        changes: unknown[];
        staged: unknown[];
        untracked: unknown[];
        merge: unknown[];
      };
      expect(payload.staged.map((f) => (f as { path: string }).path)).toEqual([
        "src/staged.ts",
        "src/added.ts",
        "src/new.ts",
      ]);
      expect(payload.changes.map((f) => (f as { path: string }).path)).toEqual(["src/unstaged.ts"]);
      expect(payload.untracked.map((f) => (f as { path: string }).path)).toEqual([
        "src/untracked.ts",
      ]);
      // Renamed entries keep the new path and carry a rename status (staged).
      expect(payload.staged.map((f) => (f as { status: string }).status)).toContain("R");
      expect(payload.staged.map((f) => (f as { path: string }).path)).toContain("src/new.ts");
    });

    it("routes unmerged conflict codes into the merge group", async () => {
      const porcelain = ["UU src/conflict.ts", "AA src/added-conflict.ts"].join("\0");
      hoisted.runGit.mockResolvedValue(okResult(porcelain));

      const calls = await invokeScm("scm.status", { repoRoot: "/repo" });
      const payload = calls[0]?.payload as { merge: Array<{ path: string; status: string }> };
      expect(payload.merge).toHaveLength(2);
      expect(payload.merge.map((f) => f.path)).toEqual([
        "src/conflict.ts",
        "src/added-conflict.ts",
      ]);
      expect(payload.merge.every((f) => f.status === "U")).toBe(true);
    });

    it("reports git failures as an invalid-request error", async () => {
      hoisted.runGit.mockResolvedValue(errorResult("not a git repository"));

      const calls = await invokeScm("scm.status", { repoRoot: "/repo" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ok).toBe(false);
      expect((calls[0]?.error as { message: string } | undefined)?.message ?? "").toContain(
        "not a git repository",
      );
    });
  });

  describe("authorization", () => {
    it("stops without a success response when the repo root is unauthorized", async () => {
      hoisted.resolveAuthorizedRepoRoot.mockImplementation((_method, _repoRoot, opts) => {
        opts.respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "outside configured agent workspaces",
        });
        return undefined;
      });

      const calls = await invokeScm("scm.status", { repoRoot: "/elsewhere" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ok).toBe(false);
      expect(hoisted.runGit).not.toHaveBeenCalled();
    });
  });

  describe("scm.commit", () => {
    it("commits and returns HEAD hash on success", async () => {
      hoisted.runGit
        .mockResolvedValueOnce(okResult("")) // commit
        .mockResolvedValueOnce(okResult("abc123def456\n")); // rev-parse HEAD

      const calls = await invokeScm("scm.commit", { repoRoot: "/repo", message: "feat: x" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ok).toBe(true);
      const payload = calls[0]?.payload as { hash: string } | undefined;
      expect(payload?.hash ?? "").toBe("abc123def456");
      expect(hoisted.runGit).toHaveBeenNthCalledWith(1, "/repo", ["commit", "-m", "feat: x"]);
      expect(hoisted.runGit).toHaveBeenNthCalledWith(2, "/repo", ["rev-parse", "HEAD"]);
    });

    it("reports commit failure without reading HEAD", async () => {
      hoisted.runGit.mockResolvedValueOnce(errorResult("nothing to commit"));

      const calls = await invokeScm("scm.commit", { repoRoot: "/repo", message: "x" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ok).toBe(false);
      expect(hoisted.runGit).toHaveBeenCalledTimes(1);
    });
  });
});
