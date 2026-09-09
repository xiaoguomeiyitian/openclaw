import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

/**
 * Commit message input plus a commit button. The button is disabled while
 * there are no staged changes or while a commit is in flight. The page owns
 * the actual `scm.commit` call; this component only emits intent.
 */
export class ScmCommitBox extends OpenClawLightDomElement {
  @state() message = "";
  @state() hasStaged = false;
  @state() committing = false;
  @state() lastCommitHash: string | null = null;

  private emitCommit() {
    if (!this.canCommit) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("scm-commit", {
        detail: { message: this.message },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private get canCommit(): boolean {
    return this.hasStaged && !this.committing && this.message.trim().length > 0;
  }

  override render() {
    return html`
      <div class="scm-commit-box">
        <textarea
          class="scm-commit-box__input"
          rows="4"
          placeholder=${t("scm.commitPlaceholder")}
          aria-label=${t("scm.commitPlaceholder")}
          ?disabled=${this.committing}
          .value=${this.message}
          @input=${(event: Event) => {
            // SAFETY: this input listener is bound directly to the textarea below.
            this.message = (event.target as HTMLTextAreaElement).value;
          }}
        ></textarea>
        <div class="scm-commit-box__footer">
          <span class="scm-commit-box__status"
            >${this.lastCommitHash ? t("scm.committed", { hash: this.lastCommitHash }) : nothing}</span
          >
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${!this.canCommit}
            @click=${() => this.emitCommit()}
          >
            ${this.committing ? t("common.loading") : t("scm.commit")}
          </button>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-scm-commit-box")) {
  customElements.define("openclaw-scm-commit-box", ScmCommitBox);
}
