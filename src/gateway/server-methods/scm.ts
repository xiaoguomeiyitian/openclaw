import {
  ErrorCodes,
  errorShape,
  validateScmBranchesParams,
  validateScmCheckoutNewParams,
  validateScmCheckoutParams,
  validateScmCommitParams,
  validateScmConflictsParams,
  validateScmDiffParams,
  validateScmFetchParams,
  validateScmLogParams,
  validateScmPullParams,
  validateScmPushParams,
  validateScmResolveParams,
  validateScmStageParams,
  validateScmStatusParams,
  validateScmUnstageParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { runGit } from "../../agents/worktrees/git.js";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveAuthorizedRepoRoot } from "./worktrees.js";

// Source-control status letter matches `git status --porcelain=v1` long/short codes.
type ScmStatusLetter = "M" | "A" | "D" | "U" | "R" | "C" | "T" | "!";

type ScmStatusFile = {
  path: string;
  status: ScmStatusLetter;
  staged: boolean;
};

// Merge (unmerged/conflicted) is derived from both columns matching a conflict code.
const SCM_MERGE_CODES = new Set(["UU", "AA", "DD", "AU", "UD", "UA", "DU"]);

// Diff output is capped to keep a single RPC payload bounded; truncated marks the cut.
const SCM_DIFF_MAX_OUTPUT_BYTES = 512 * 1024;

function invalidParams(respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"]): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid scm parameters"));
}

/**
 * Reverse git's C-style quoted path escaping so status entries with spaces or
 * non-ASCII bytes render as the real filesystem path.
 */
function decodeGitQuotedPath(quoted: string): string {
  if (quoted.startsWith('"')) {
    try {
      const parsed = JSON.parse(quoted) as unknown;
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      // Fall through to byte-wise decoding when the path is not valid JSON.
    }
  }
  // porcelain=v1 quotes each non-printable byte as octal \NNN. Re-decode them.
  return quoted.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function scmStatusLetter(value: string): ScmStatusLetter | null {
  return value === "M" ||
    value === "A" ||
    value === "D" ||
    value === "U" ||
    value === "R" ||
    value === "C" ||
    value === "T" ||
    value === "!"
    ? value
    : null;
}

/**
 * Parse `git status --porcelain=v1 -z` output into status entries grouped by
 * index/worktree state. Rename/copy entries carry `old -> new`; the new path
 * is the one the source-control panel stages.
 */
function parsePorcelainStatus(output: string): ScmStatusFile[] {
  const entries: ScmStatusFile[] = [];
  // -z terminates records with NUL; each record is `XY PATH` exactly once.
  const records = output.split("\0").filter((record) => record.length > 0);
  for (const record of records) {
    // Short format is fixed-width: two status columns, one space, then path.
    if (record.length < 4 || record[2] !== " ") {
      continue;
    }
    const x = record.charAt(0);
    const y = record.charAt(1);
    const rawPath = record.slice(3);
    let path = rawPath;
    // Rename/copy records carry `old -> new` with a literal " -> " separator.
    const arrowIndex = rawPath.indexOf(" -> ");
    if ((x === "R" || x === "C" || y === "R" || y === "C") && arrowIndex >= 0) {
      path = rawPath.slice(arrowIndex + " -> ".length);
    }
    const code = `${x}${y}`;
    if (SCM_MERGE_CODES.has(code)) {
      entries.push({ path: decodeGitQuotedPath(path), status: "U", staged: false });
      continue;
    }
    // `??` is porcelain=v1's untracked marker; surface it under the `!` status
    // so the untracked group stays visually distinct from tracked changes.
    if (x === "?" && y === "?") {
      entries.push({ path: decodeGitQuotedPath(path), status: "!", staged: false });
      continue;
    }
    if (x === "?") {
      const status = scmStatusLetter(y);
      if (status) {
        entries.push({ path: decodeGitQuotedPath(path), status, staged: false });
      }
      continue;
    }
    if (x === "!") {
      entries.push({ path: decodeGitQuotedPath(path), status: "!", staged: false });
      continue;
    }
    // Index column holds a real letter: staged against HEAD.
    if (x !== " " && x !== "?") {
      const status = scmStatusLetter(x);
      if (status) {
        entries.push({ path: decodeGitQuotedPath(path), status, staged: true });
      }
      continue;
    }
    // Unchanged index, changed worktree: unstaged change; `?` marks untracked.
    const status = scmStatusLetter(y);
    if (status) {
      entries.push({ path: decodeGitQuotedPath(path), status, staged: false });
    }
  }
  return entries;
}

function groupStatusEntries(entries: ScmStatusFile[]): {
  changes: ScmStatusFile[];
  staged: ScmStatusFile[];
  untracked: ScmStatusFile[];
  merge: ScmStatusFile[];
} {
  const changes: ScmStatusFile[] = [];
  const staged: ScmStatusFile[] = [];
  const untracked: ScmStatusFile[] = [];
  const merge: ScmStatusFile[] = [];
  for (const entry of entries) {
    if (entry.status === "U") {
      merge.push(entry);
    } else if (entry.status === "!") {
      untracked.push(entry);
    } else if (entry.staged) {
      staged.push(entry);
    } else {
      changes.push(entry);
    }
  }
  return { changes, staged, untracked, merge };
}

type ScmBranch = {
  name: string;
  isCurrent: boolean;
};

/**
 * Parse `git branch --format=%(refname:short)|%(HEAD)` lines into branch
 * entries. `%(HEAD)` renders `*` for the checked-out branch, empty otherwise.
 */
function parseBranches(output: string): ScmBranch[] {
  const branches: ScmBranch[] = [];
  for (const line of output.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const separator = line.indexOf("|");
    if (separator < 0) {
      branches.push({ name: line, isCurrent: false });
      continue;
    }
    branches.push({
      name: line.slice(0, separator),
      isCurrent: line.slice(separator + 1) === "*",
    });
  }
  return branches;
}

/**
 * Parse `git rev-list --left-right --count HEAD...@{upstream}` (tab-separated
 * `behind ahead`) into an ahead/behind pair.
 */
function parseAheadBehind(output: string): { ahead: number; behind: number } | null {
  const columns = output.trim().split(/\s+/);
  if (columns.length !== 2) {
    return null;
  }
  const behind = Number.parseInt(columns[0] ?? "", 10);
  const ahead = Number.parseInt(columns[1] ?? "", 10);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
    return null;
  }
  return { ahead, behind };
}

/**
 * Parse `git log --format=%H%x00%an%x00%aI%x00%s` output into commit records.
 * Each commit is one line; fields are NUL-separated (hash, author, date, subject).
 */
function parseLog(
  output: string,
): Array<{ hash: string; author: string; date: string; message: string }> {
  const commits: Array<{ hash: string; author: string; date: string; message: string }> = [];
  for (const line of output.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const fields = line.split("\0");
    if (fields.length !== 4) {
      continue;
    }
    const hash = fields[0] ?? "";
    const author = fields[1] ?? "";
    const date = fields[2] ?? "";
    const message = fields[3] ?? "";
    if (!hash || !author || !date || !message) {
      continue;
    }
    commits.push({ hash, author, date, message });
  }
  return commits;
}

/** Parse `git diff --name-only --diff-filter=U` into a list of conflicted paths. */
function parseConflicts(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function createScmHandlers(): GatewayRequestHandlers {
  return {
    "scm.status": async (opts) => {
      const { params, respond } = opts;
      if (!validateScmStatusParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("scm.status", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const result = await runGit(repoRoot, ["status", "--porcelain=v1", "-z"]);
      if (result.termination !== "exit" || result.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, result.stderr || "git status failed"),
        );
        return;
      }
      respond(true, groupStatusEntries(parsePorcelainStatus(result.stdout)), undefined);
    },
    "scm.diff": async (opts) => {
      const { params, respond } = opts;
      if (!validateScmDiffParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("scm.diff", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const args = params.staged
        ? ["diff", "--cached", "--", params.path]
        : ["diff", "--", params.path];
      const result = await runGit(repoRoot, args, { maxOutputBytes: SCM_DIFF_MAX_OUTPUT_BYTES });
      if (result.termination !== "exit" || result.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, result.stderr || "git diff failed"),
        );
        return;
      }
      // Output capture truncates in place without failing the command; recover the
      // cap signal so the client can show a honest "diff truncated" banner.
      const truncated =
        (result.stdoutTruncatedBytes ?? 0) > 0 || result.outputLimitExceeded === true;
      respond(true, { diff: result.stdout, ...(truncated ? { truncated } : {}) }, undefined);
    },
    "scm.stage": async (opts) => {
      const { params, respond } = opts;
      if (!validateScmStageParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("scm.stage", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const result = await runGit(repoRoot, ["add", "--", ...params.paths]);
      if (result.termination !== "exit" || result.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, result.stderr || "git add failed"),
        );
        return;
      }
      respond(true, {}, undefined);
    },
    "scm.unstage": async (opts) => {
      const { params, respond } = opts;
      if (!validateScmUnstageParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("scm.unstage", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const result = await runGit(repoRoot, ["restore", "--staged", "--", ...params.paths]);
      if (result.termination !== "exit" || result.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, result.stderr || "git restore failed"),
        );
        return;
      }
      respond(true, {}, undefined);
    },
    "scm.commit": async (opts) => {
      const { params, respond } = opts;
      if (!validateScmCommitParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("scm.commit", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const commit = await runGit(repoRoot, ["commit", "-m", params.message]);
      if (commit.termination !== "exit" || commit.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, commit.stderr || "git commit failed"),
        );
        return;
      }
      const revParse = await runGit(repoRoot, ["rev-parse", "HEAD"]);
      if (revParse.termination !== "exit" || revParse.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, revParse.stderr || "git rev-parse failed"),
        );
        return;
      }
      respond(true, { hash: revParse.stdout.trim() }, undefined);
    },
    "scm.branches": async (opts) => {
      const { params, respond } = opts;
      if (!validateScmBranchesParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("scm.branches", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const list = await runGit(repoRoot, [
        "branch",
        "--format=%(refname:short)|%(HEAD)",
        "--sort=refname",
      ]);
      if (list.termination !== "exit" || list.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, list.stderr || "git branch failed"),
        );
        return;
      }
      const current = await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (current.termination !== "exit" || current.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, current.stderr || "git rev-parse failed"),
        );
        return;
      }
      // Ahead/behind only reflects an upstream tracking branch; absent upstream
      // (or a fresh local branch) is not an error, so drop the counts silently.
      const aheadBehind = await runGit(repoRoot, [
        "rev-list",
        "--left-right",
        "--count",
        "HEAD...@{upstream}",
      ]);
      const counts =
        aheadBehind.termination !== "exit" || aheadBehind.code !== 0
          ? null
          : parseAheadBehind(aheadBehind.stdout);
      respond(
        true,
        {
          branches: parseBranches(list.stdout),
          current: current.stdout.trim(),
          ...(counts ? { ahead: counts.ahead, behind: counts.behind } : {}),
        },
        undefined,
      );
    },
    "scm.checkout": async (opts) => {
      const { params, respond } = opts;
      if (!validateScmCheckoutParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("scm.checkout", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const result = await runGit(repoRoot, ["checkout", params.branch]);
      if (result.termination !== "exit" || result.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, result.stderr || "git checkout failed"),
        );
        return;
      }
      respond(true, {}, undefined);
    },
    "scm.checkoutNew": async (opts) => {
      const { params, respond } = opts;
      if (!validateScmCheckoutNewParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("scm.checkoutNew", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const result = await runGit(repoRoot, ["checkout", "-b", params.name]);
      if (result.termination !== "exit" || result.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, result.stderr || "git checkout failed"),
        );
        return;
      }
      respond(true, {}, undefined);
    },
    "scm.fetch": async (opts) => {
      const { params, respond } = opts;
      if (!validateScmFetchParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("scm.fetch", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const result = await runGit(repoRoot, ["fetch"]);
      if (result.termination !== "exit" || result.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, result.stderr || "git fetch failed"),
        );
        return;
      }
      respond(true, {}, undefined);
    },
    "scm.pull": async (opts) => {
      const { params, respond } = opts;
      if (!validateScmPullParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("scm.pull", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const result = await runGit(repoRoot, ["pull"]);
      if (result.termination !== "exit" || result.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, result.stderr || "git pull failed"),
        );
        return;
      }
      respond(true, {}, undefined);
    },
    "scm.push": async (opts) => {
      const { params, respond } = opts;
      if (!validateScmPushParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("scm.push", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const result = await runGit(repoRoot, ["push"]);
      if (result.termination !== "exit" || result.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, result.stderr || "git push failed"),
        );
        return;
      }
      respond(true, {}, undefined);
    },
    "scm.log": async (opts) => {
      const { params, respond } = opts;
      if (!validateScmLogParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("scm.log", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const limit = params.limit ?? 20;
      const result = await runGit(repoRoot, [
        "log",
        "--format=%H%x00%an%x00%aI%x00%s",
        `-n ${limit}`,
      ]);
      if (result.termination !== "exit" || result.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, result.stderr || "git log failed"),
        );
        return;
      }
      respond(true, { commits: parseLog(result.stdout) }, undefined);
    },
    "scm.conflicts": async (opts) => {
      const { params, respond } = opts;
      if (!validateScmConflictsParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("scm.conflicts", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const result = await runGit(repoRoot, ["diff", "--name-only", "--diff-filter=U"]);
      if (result.termination !== "exit" || result.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, result.stderr || "git diff failed"),
        );
        return;
      }
      respond(true, { paths: parseConflicts(result.stdout) }, undefined);
    },
    "scm.resolve": async (opts) => {
      const { params, respond } = opts;
      if (!validateScmResolveParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("scm.resolve", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const flag = params.resolution === "theirs" ? "--theirs" : "--ours";
      const checkout = await runGit(repoRoot, ["checkout", flag, "--", params.path]);
      if (checkout.termination !== "exit" || checkout.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, checkout.stderr || "git checkout failed"),
        );
        return;
      }
      const add = await runGit(repoRoot, ["add", "--", params.path]);
      if (add.termination !== "exit" || add.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, add.stderr || "git add failed"),
        );
        return;
      }
      respond(true, {}, undefined);
    },
  };
}

export const scmHandlers = createScmHandlers();
