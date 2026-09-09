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
