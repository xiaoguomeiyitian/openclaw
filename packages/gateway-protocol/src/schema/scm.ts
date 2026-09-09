import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

// Source-control file statuses mirror `git status --porcelain=v1` codes:
// M/A/D/U/R/C/T plus `!` for untracked and space for unchanged.
const SCM_STATUS_VALUES = ["M", "A", "D", "U", "R", "C", "T", "!"] as const;

export const ScmStatusParamsSchema = closedObject({
  repoRoot: NonEmptyString,
});

export const ScmStatusFileSchema = closedObject({
  path: NonEmptyString,
  status: Type.String({ enum: [...SCM_STATUS_VALUES] }),
  staged: Type.Boolean(),
});

export const ScmStatusResultSchema = closedObject({
  changes: Type.Array(ScmStatusFileSchema),
  staged: Type.Array(ScmStatusFileSchema),
  untracked: Type.Array(ScmStatusFileSchema),
  merge: Type.Array(ScmStatusFileSchema),
});

export const ScmDiffParamsSchema = closedObject({
  repoRoot: NonEmptyString,
  path: NonEmptyString,
  staged: Type.Optional(Type.Boolean()),
});

export const ScmDiffResultSchema = closedObject({
  diff: Type.String(),
  truncated: Type.Optional(Type.Boolean()),
});

export const ScmStageParamsSchema = closedObject({
  repoRoot: NonEmptyString,
  paths: Type.Array(NonEmptyString),
});

export const ScmUnstageParamsSchema = closedObject({
  repoRoot: NonEmptyString,
  paths: Type.Array(NonEmptyString),
});

export const ScmCommitParamsSchema = closedObject({
  repoRoot: NonEmptyString,
  message: Type.String({ minLength: 1, maxLength: 5000 }),
});

export const ScmCommitResultSchema = closedObject({
  hash: NonEmptyString,
});

// Phase 2: branches and ref mutations (checkout/checkoutNew/fetch/pull/push).
export const ScmBranchesParamsSchema = closedObject({
  repoRoot: NonEmptyString,
});

export const ScmBranchSchema = closedObject({
  name: NonEmptyString,
  isCurrent: Type.Boolean(),
});

export const ScmBranchesResultSchema = closedObject({
  branches: Type.Array(ScmBranchSchema),
  current: NonEmptyString,
  ahead: Type.Optional(Type.Integer()),
  behind: Type.Optional(Type.Integer()),
});

export const ScmCheckoutParamsSchema = closedObject({
  repoRoot: NonEmptyString,
  branch: NonEmptyString,
});

export const ScmCheckoutNewParamsSchema = closedObject({
  repoRoot: NonEmptyString,
  name: NonEmptyString,
});

export const ScmFetchParamsSchema = closedObject({
  repoRoot: NonEmptyString,
});

export const ScmPullParamsSchema = closedObject({
  repoRoot: NonEmptyString,
});

export const ScmPushParamsSchema = closedObject({
  repoRoot: NonEmptyString,
});

// Phase 3: commit history, merge conflicts, and conflict resolution.
export const ScmLogParamsSchema = closedObject({
  repoRoot: NonEmptyString,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const ScmCommitInfoSchema = closedObject({
  hash: NonEmptyString,
  author: NonEmptyString,
  date: NonEmptyString,
  message: NonEmptyString,
});

export const ScmLogResultSchema = closedObject({
  commits: Type.Array(ScmCommitInfoSchema),
});

export const ScmConflictsParamsSchema = closedObject({
  repoRoot: NonEmptyString,
});

export const ScmConflictsResultSchema = closedObject({
  paths: Type.Array(NonEmptyString),
});

export const ScmResolveParamsSchema = closedObject({
  repoRoot: NonEmptyString,
  path: NonEmptyString,
  resolution: Type.String({ enum: ["theirs", "ours"] }),
});

// Wire types derive directly from local schema consts so public d.ts graphs
// never pull in the ProtocolSchemas registry.
export type ScmStatusParams = Static<typeof ScmStatusParamsSchema>;
export type ScmStatusFile = Static<typeof ScmStatusFileSchema>;
export type ScmStatusResult = Static<typeof ScmStatusResultSchema>;
export type ScmDiffParams = Static<typeof ScmDiffParamsSchema>;
export type ScmDiffResult = Static<typeof ScmDiffResultSchema>;
export type ScmStageParams = Static<typeof ScmStageParamsSchema>;
export type ScmUnstageParams = Static<typeof ScmUnstageParamsSchema>;
export type ScmCommitParams = Static<typeof ScmCommitParamsSchema>;
export type ScmCommitResult = Static<typeof ScmCommitResultSchema>;
export type ScmBranchesParams = Static<typeof ScmBranchesParamsSchema>;
export type ScmBranch = Static<typeof ScmBranchSchema>;
export type ScmBranchesResult = Static<typeof ScmBranchesResultSchema>;
export type ScmCheckoutParams = Static<typeof ScmCheckoutParamsSchema>;
export type ScmCheckoutNewParams = Static<typeof ScmCheckoutNewParamsSchema>;
export type ScmFetchParams = Static<typeof ScmFetchParamsSchema>;
export type ScmPullParams = Static<typeof ScmPullParamsSchema>;
export type ScmPushParams = Static<typeof ScmPushParamsSchema>;
export type ScmLogParams = Static<typeof ScmLogParamsSchema>;
export type ScmCommitInfo = Static<typeof ScmCommitInfoSchema>;
export type ScmLogResult = Static<typeof ScmLogResultSchema>;
export type ScmConflictsParams = Static<typeof ScmConflictsParamsSchema>;
export type ScmConflictsResult = Static<typeof ScmConflictsResultSchema>;
export type ScmResolveParams = Static<typeof ScmResolveParamsSchema>;
