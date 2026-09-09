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

  describe("scm.branches", () => {
    it("parses branches, current, and ahead/behind counts", async () => {
      hoisted.runGit
        .mockResolvedValueOnce(okResult("feature/a|\nmain|*\ndev|"))
        .mockResolvedValueOnce(okResult("main\n"))
        .mockResolvedValueOnce(okResult("2\t3"));

      const calls = await invokeScm("scm.branches", { repoRoot: "/repo" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ok).toBe(true);
      const payload = calls[0]?.payload as {
        branches: Array<{ name: string; isCurrent: boolean }>;
        current: string;
        ahead?: number;
        behind?: number;
      };
      expect(payload.branches).toEqual([
        { name: "feature/a", isCurrent: false },
        { name: "main", isCurrent: true },
        { name: "dev", isCurrent: false },
      ]);
      expect(payload.current).toBe("main");
      expect(payload.ahead).toBe(3);
      expect(payload.behind).toBe(2);
      expect(hoisted.runGit).toHaveBeenNthCalledWith(1, "/repo", [
        "branch",
        "--format=%(refname:short)|%(HEAD)",
        "--sort=refname",
      ]);
      expect(hoisted.runGit).toHaveBeenNthCalledWith(2, "/repo", [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      expect(hoisted.runGit).toHaveBeenNthCalledWith(3, "/repo", [
        "rev-list",
        "--left-right",
        "--count",
        "HEAD...@{upstream}",
      ]);
    });

    it("drops ahead/behind when upstream tracking is missing", async () => {
      hoisted.runGit
        .mockResolvedValueOnce(okResult("main|*"))
        .mockResolvedValueOnce(okResult("main\n"))
        .mockResolvedValueOnce(errorResult("no upstream"));

      const calls = await invokeScm("scm.branches", { repoRoot: "/repo" });
      const payload = calls[0]?.payload as { ahead?: number; behind?: number };
      expect(calls[0]?.ok).toBe(true);
      expect(payload.ahead).toBeUndefined();
      expect(payload.behind).toBeUndefined();
    });
  });

  describe("scm.checkout and checkoutNew", () => {
    it("checks out an existing branch", async () => {
      hoisted.runGit.mockResolvedValueOnce(okResult(""));

      const calls = await invokeScm("scm.checkout", { repoRoot: "/repo", branch: "main" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ok).toBe(true);
      expect(hoisted.runGit).toHaveBeenCalledWith("/repo", ["checkout", "main"]);
    });

    it("creates and checks out a new branch", async () => {
      hoisted.runGit.mockResolvedValueOnce(okResult(""));

      const calls = await invokeScm("scm.checkoutNew", {
        repoRoot: "/repo",
        name: "feature/x",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ok).toBe(true);
      expect(hoisted.runGit).toHaveBeenCalledWith("/repo", ["checkout", "-b", "feature/x"]);
    });

    it("reports checkout failure", async () => {
      hoisted.runGit.mockResolvedValueOnce(errorResult("local changes would be overwritten"));

      const calls = await invokeScm("scm.checkout", { repoRoot: "/repo", branch: "main" });
      expect(calls[0]?.ok).toBe(false);
    });
  });

  describe("scm.fetch/pull/push", () => {
    it.each([
      ["scm.fetch", ["fetch"]],
      ["scm.pull", ["pull"]],
      ["scm.push", ["push"]],
    ])('runs "%s" via the matching git command', async (method, args) => {
      hoisted.runGit.mockResolvedValueOnce(okResult(""));

      const calls = await invokeScm(method, { repoRoot: "/repo" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ok).toBe(true);
      expect(hoisted.runGit).toHaveBeenCalledWith("/repo", args);
    });
  });

  describe("scm.log", () => {
    it("parses NUL-separated commit log output", async () => {
      const nul = "\u0000";
      hoisted.runGit.mockResolvedValueOnce(
        okResult(
          `abc123${nul}Alice${nul}2026-09-09T01:00:00+00:00${nul}feat: first\ndef456${nul}Bob${nul}2026-09-09T02:00:00+00:00${nul}fix: second`,
        ),
      );

      const calls = await invokeScm("scm.log", { repoRoot: "/repo", limit: 10 });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ok).toBe(true);
      const payload = calls[0]?.payload as {
        commits: Array<{ hash: string; author: string; date: string; message: string }>;
      };
      expect(payload.commits).toEqual([
        {
          hash: "abc123",
          author: "Alice",
          date: "2026-09-09T01:00:00+00:00",
          message: "feat: first",
        },
        {
          hash: "def456",
          author: "Bob",
          date: "2026-09-09T02:00:00+00:00",
          message: "fix: second",
        },
      ]);
      expect(hoisted.runGit).toHaveBeenCalledWith("/repo", [
        "log",
        "--format=%H%x00%an%x00%aI%x00%s",
        "-n 10",
      ]);
    });

    it("defaults the limit to 20 when omitted", async () => {
      hoisted.runGit.mockResolvedValueOnce(okResult(""));

      const calls = await invokeScm("scm.log", { repoRoot: "/repo" });
      expect(calls[0]?.ok).toBe(true);
      expect(hoisted.runGit).toHaveBeenCalledWith("/repo", [
        "log",
        "--format=%H%x00%an%x00%aI%x00%s",
        "-n 20",
      ]);
    });
  });

  describe("scm.conflicts", () => {
    it("parses conflicted paths and drops blank lines", async () => {
      hoisted.runGit.mockResolvedValueOnce(okResult("src/a.ts\n\nsrc/b.ts\n"));

      const calls = await invokeScm("scm.conflicts", { repoRoot: "/repo" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ok).toBe(true);
      const payload = calls[0]?.payload as { paths: string[] };
      expect(payload.paths).toEqual(["src/a.ts", "src/b.ts"]);
      expect(hoisted.runGit).toHaveBeenCalledWith("/repo", [
        "diff",
        "--name-only",
        "--diff-filter=U",
      ]);
    });
  });

  describe("scm.resolve", () => {
    it.each([
      ["theirs", "--theirs"],
      ["ours", "--ours"],
    ])("resolves with %s side and stages the path", async (resolution, flag) => {
      hoisted.runGit.mockResolvedValueOnce(okResult("")); // checkout --theirs/--ours
      hoisted.runGit.mockResolvedValueOnce(okResult("")); // add

      const calls = await invokeScm("scm.resolve", {
        repoRoot: "/repo",
        path: "src/a.ts",
        resolution,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ok).toBe(true);
      expect(hoisted.runGit).toHaveBeenNthCalledWith(1, "/repo", [
        "checkout",
        flag,
        "--",
        "src/a.ts",
      ]);
      expect(hoisted.runGit).toHaveBeenNthCalledWith(2, "/repo", ["add", "--", "src/a.ts"]);
    });

    it("reports checkout failure without staging", async () => {
      hoisted.runGit.mockResolvedValueOnce(errorResult("pathspec did not match"));

      const calls = await invokeScm("scm.resolve", {
        repoRoot: "/repo",
        path: "src/a.ts",
        resolution: "theirs",
      });
      expect(calls[0]?.ok).toBe(false);
      expect(hoisted.runGit).toHaveBeenCalledTimes(1);
    });
  });
});
