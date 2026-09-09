import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type { ScmStatusFile } from "../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import type { ScmGroupKey } from "./scm-state.ts";

// Status letters that render with a hint color for scannability. The letter is
// still the primary signal; color is a fast grouping aid only.
const STATUS_LETTER_CLASS: Record<string, string> = {
  M: "scm-status--modified",
  A: "scm-status--added",
  D: "scm-status--deleted",
  U: "scm-status--conflict",
  R: "scm-status--renamed",
  C: "scm-status--copied",
  T: "scm-status--typechanged",
};

type ScmGroupDefinition = {
  key: ScmGroupKey;
  titleKey: string;
  emptyKey: string;
};

const GROUP_DEFINITIONS: ScmGroupDefinition[] = [
  { key: "staged", titleKey: "scm.groupStaged", emptyKey: "scm.emptyStaged" },
  { key: "changes", titleKey: "scm.groupChanges", emptyKey: "scm.emptyChanges" },
  { key: "untracked", titleKey: "scm.groupUntracked", emptyKey: "scm.emptyUntracked" },
  { key: "merge", titleKey: "scm.groupMerge", emptyKey: "scm.emptyMerge" },
];

/**
 * Renders the four source-control groups (Staged / Changes / Untracked / Merge)
 * with per-file stage/unstage actions. Selection is reported upward for diff
 * preview; the page owns the actual git mutation calls.
 */
export class ScmChangesTree extends OpenClawLightDomElement {
  @state() status: {
    changes: ScmStatusFile[];
    staged: ScmStatusFile[];
    untracked: ScmStatusFile[];
    merge: ScmStatusFile[];
  } = {
    changes: [],
    staged: [],
    untracked: [],
    merge: [],
  };

  @state() selectedPath: string | null = null;

  /** Fire a custom event so the page can action stage/unstage without a tight coupling. */
  private emitAction(action: "stage" | "unstage", path: string) {
    this.dispatchEvent(
      new CustomEvent("scm-action", {
        detail: { action, path },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private emitSelect(path: string) {
    this.dispatchEvent(
      new CustomEvent("scm-select", {
        detail: { path },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderFileRow(file: ScmStatusFile, group: ScmGroupKey) {
    const statusClass = STATUS_LETTER_CLASS[file.status] ?? "";
    const isStaged = group === "staged";
    const actionIcon = isStaged ? icons.x : icons.plus;
    const actionLabel = isStaged ? t("scm.unstageFile") : t("scm.stageFile");
    const selected = this.selectedPath === file.path;
    return html`
      <li class="scm-changes-tree__row${selected ? " scm-changes-tree__row--selected" : ""}">
        <button
          type="button"
          class="scm-changes-tree__path"
          @click=${() => this.emitSelect(file.path)}
        >
          <span class="scm-status__letter ${statusClass}" aria-hidden="true">${file.status}</span>
          <span class="scm-changes-tree__name">${file.path}</span>
        </button>
        <button
          type="button"
          class="scm-changes-tree__action"
          title=${actionLabel}
          aria-label=${actionLabel}
          @click=${() => this.emitAction(isStaged ? "unstage" : "stage", file.path)}
        >
          ${actionIcon}
        </button>
      </li>
    `;
  }

  private renderGroup(definition: ScmGroupDefinition) {
    const files = this.status[definition.key];
    if (files.length === 0) {
      return nothing;
    }
    return html`
      <section class="scm-changes-tree__group">
        <h3 class="scm-changes-tree__heading">${t(definition.titleKey)}</h3>
        <ul class="scm-changes-tree__list">
          ${files.map((file) => this.renderFileRow(file, definition.key))}
        </ul>
      </section>
    `;
  }

  override render() {
    const hasAny =
      this.status.changes.length > 0 ||
      this.status.staged.length > 0 ||
      this.status.untracked.length > 0 ||
      this.status.merge.length > 0;
    if (!hasAny) {
      return html`<div class="scm-changes-tree__empty">${t("scm.clean")}</div>`;
    }
    return html`${GROUP_DEFINITIONS.map((definition) => this.renderGroup(definition))}`;
  }
}

if (!customElements.get("openclaw-scm-changes-tree")) {
  customElements.define("openclaw-scm-changes-tree", ScmChangesTree);
}
