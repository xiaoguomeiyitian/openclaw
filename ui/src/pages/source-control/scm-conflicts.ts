import { html } from "lit";
import { state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

/**
 * Conflicted-file list with per-file resolution actions. The page owns the
 * `scm.resolve` call; this component only reports the chosen side upward.
 */
export class ScmConflicts extends OpenClawLightDomElement {
  @state() paths: string[] = [];
  @state() busy = false;

  private emitResolve(path: string, resolution: "theirs" | "ours") {
    if (this.busy) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("scm-resolve", {
        detail: { path, resolution },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    if (this.paths.length === 0) {
      return html`<div class="scm-conflicts__empty">${t("scm.noConflicts")}</div>`;
    }
    return html`
      <ul class="scm-conflicts__list">
        ${this.paths.map(
          (path) => html`
            <li class="scm-conflicts__row">
              <span class="scm-conflicts__path">${path}</span>
              <div class="scm-conflicts__actions">
                <button
                  type="button"
                  class="btn btn--sm"
                  ?disabled=${this.busy}
                  @click=${() => this.emitResolve(path, "theirs")}
                >
                  ${t("scm.takeTheirs")}
                </button>
                <button
                  type="button"
                  class="btn btn--sm"
                  ?disabled=${this.busy}
                  @click=${() => this.emitResolve(path, "ours")}
                >
                  ${t("scm.takeOurs")}
                </button>
              </div>
            </li>
          `,
        )}
      </ul>
    `;
  }
}

if (!customElements.get("openclaw-scm-conflicts")) {
  customElements.define("openclaw-scm-conflicts", ScmConflicts);
}
