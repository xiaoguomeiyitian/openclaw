import { html } from "lit";
import { state } from "lit/decorators.js";
import type { ScmCommitInfo } from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

/**
 * Read-only commit log list. Data is pushed in by the page via the `commits`
 * property; the component performs no RPC of its own.
 */
export class ScmHistory extends OpenClawLightDomElement {
  @state() commits: ScmCommitInfo[] = [];

  private static shortHash(hash: string): string {
    return hash.slice(0, 7);
  }

  override render() {
    if (this.commits.length === 0) {
      return html`<div class="scm-history__empty">${t("scm.noHistory")}</div>`;
    }
    return html`
      <ul class="scm-history__list">
        ${this.commits.map(
          (commit) => html`
            <li class="scm-history__row">
              <span class="scm-history__hash">${ScmHistory.shortHash(commit.hash)}</span>
              <div class="scm-history__body">
                <span class="scm-history__message">${commit.message}</span>
                <span class="scm-history__meta">${commit.author} · ${commit.date}</span>
              </div>
            </li>
          `,
        )}
      </ul>
    `;
  }
}

if (!customElements.get("openclaw-scm-history")) {
  customElements.define("openclaw-scm-history", ScmHistory);
}
