import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

/**
 * Renders a selected file's diff as plain `<pre>` text. Phase 1 keeps line-level
 * highlighting out of scope; truncation is surfaced from the server's cap marker.
 */
export class ScmDiffView extends OpenClawLightDomElement {
  @state() path: string | null = null;
  @state() diff = "";
  @state() truncated = false;
  @state() loading = false;
  @state() error: string | null = null;

  override render() {
    if (this.loading) {
      return html`<div class="scm-diff-view__state">${t("common.loading")}</div>`;
    }
    if (this.error) {
      return html`<div class="scm-diff-view__state scm-diff-view__state--error">
        ${this.error}
      </div>`;
    }
    if (!this.path) {
      return html`<div class="scm-diff-view__state">${t("scm.selectFile")}</div>`;
    }
    if (!this.diff) {
      return html`<div class="scm-diff-view__state">${t("scm.noDiff")}</div>`;
    }
    return html`
      <div class="scm-diff-view">
        ${
          this.truncated
            ? html`<div class="scm-diff-view__truncated">${t("scm.diffTruncated")}</div>`
            : nothing
        }
        <pre class="scm-diff-view__pre">${this.diff}</pre>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-scm-diff-view")) {
  customElements.define("openclaw-scm-diff-view", ScmDiffView);
}
