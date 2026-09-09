import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type { ScmBranch } from "../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

/**
 * Branch selector plus sync controls. The page owns the actual scm.* RPC calls;
 * this component only reports intent upward through bubbling custom events.
 */
export class ScmBranches extends OpenClawLightDomElement {
  @state() branches: ScmBranch[] = [];
  @state() current: string | null = null;
  @state() ahead: number | null = null;
  @state() behind: number | null = null;
  @state() newBranchName = "";
  @state() busy = false;

  /** Checkout an existing branch, reported upward for the page to execute. */
  private emitCheckout(branch: string) {
    if (this.busy) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("scm-checkout", {
        detail: { branch },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Create and checkout a new branch. */
  private emitCheckoutNew() {
    const name = this.newBranchName.trim();
    if (!name || this.busy) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("scm-checkout-new", {
        detail: { name },
        bubbles: true,
        composed: true,
      }),
    );
    this.newBranchName = "";
  }

  /** Emit a sync action (fetch/pull/push). */
  private emitSync(action: "fetch" | "pull" | "push") {
    if (this.busy) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("scm-sync", {
        detail: { action },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private canCheckoutNew(): boolean {
    return this.newBranchName.trim().length > 0 && !this.busy;
  }

  private renderAheadBehind() {
    if (this.ahead === null || this.behind === null) {
      return nothing;
    }
    return html`<span class="scm-branches__aheadbehind"
      >${t("scm.aheadBehind", { ahead: String(this.ahead), behind: String(this.behind) })}</span
    >`;
  }

  override render() {
    const currentLabel = this.current ? this.current : t("scm.currentBranch");
    return html`
      <div class="scm-branches">
        <div class="scm-branches__header">
          <span class="scm-branches__current">
            ${icons.diff}
            <span class="scm-branches__current-name">${currentLabel}</span>
          </span>
          ${this.renderAheadBehind()}
        </div>
        <div class="scm-branches__sync">
          <button
            type="button"
            class="btn btn--sm"
            title=${t("scm.fetch")}
            ?disabled=${this.busy}
            @click=${() => this.emitSync("fetch")}
          >
            ${icons.loader} ${t("scm.fetch")}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            title=${t("scm.pull")}
            ?disabled=${this.busy}
            @click=${() => this.emitSync("pull")}
          >
            ${icons.arrowDown} ${t("scm.pull")}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            title=${t("scm.push")}
            ?disabled=${this.busy}
            @click=${() => this.emitSync("push")}
          >
            ${icons.arrowUp} ${t("scm.push")}
          </button>
        </div>
        <ul class="scm-branches__list">
          ${this.branches.map(
            (branch) => html`
              <li class="scm-branches__row">
                <button
                  type="button"
                  class="scm-branches__name${branch.isCurrent ? " scm-branches__name--current" : ""}"
                  title=${t("scm.checkoutBranch", { branch: branch.name })}
                  ?disabled=${branch.isCurrent || this.busy}
                  @click=${() => this.emitCheckout(branch.name)}
                >
                  ${branch.isCurrent ? icons.check : icons.diff}
                  <span>${branch.name}</span>
                </button>
              </li>
            `,
          )}
        </ul>
        <div class="scm-branches__new">
          <input
            class="scm-branches__input"
            type="text"
            placeholder=${t("scm.newBranchPlaceholder")}
            aria-label=${t("scm.newBranchPlaceholder")}
            ?disabled=${this.busy}
            .value=${this.newBranchName}
            @input=${(event: Event) => {
              this.newBranchName = (event.target as HTMLInputElement).value;
            }}
          />
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${!this.canCheckoutNew()}
            @click=${() => this.emitCheckoutNew()}
          >
            ${icons.fileDiff} ${t("scm.createBranch")}
          </button>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-scm-branches")) {
  customElements.define("openclaw-scm-branches", ScmBranches);
}
