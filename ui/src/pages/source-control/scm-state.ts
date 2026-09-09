// Shared source-control group keys. The page owns request lifecycle and status
// state (see scm-page.ts); this module only publishes stable group identifiers
// consumed by the changes tree.
export type ScmGroupKey = "staged" | "changes" | "untracked" | "merge";
