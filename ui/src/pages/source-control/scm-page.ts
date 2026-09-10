import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type {
  ScmBranch,
  ScmBranchesResult,
  ScmCommitInfo,
  ScmCommitResult,
  ScmConflictsResult,
  ScmDiffResult,
  ScmLogResult,
  ScmStatusFile,
  WorktreeRecord,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import "../../styles/scm.css";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "./scm-branches.ts";
import "./scm-changes-tree.ts";
import "./scm-commit-box.ts";
import "./scm-conflicts.ts";
import "./scm-diff-view.ts";
import "./scm-history.ts";

type WorktreesListResult = { worktrees: WorktreeRecord[] };
type ScmStatusResult = {
  changes: ScmStatusFile[];
  staged: ScmStatusFile[];
  untracked: ScmStatusFile[];
  merge: ScmStatusFile[];
};
type ScmTabKey = "changes" | "branches" | "history" | "conflicts";

const SCM_TABS: Array<{ key: ScmTabKey; labelKey: string }> = [
  { key: "changes", labelKey: "scm.groupChanges" },
  { key: "branches", labelKey: "scm.branches" },
  { key: "history", labelKey: "scm.history" },
  { key: "conflicts", labelKey: "scm.conflicts" },
];

/**
 * Source Control panel container. Resolves the active worktree via
 * worktrees.list (latest `lastActiveAt`, not removed), then drives scm.status,
 * branches, history, conflicts, and coordinates the diff preview, stage/unstage,
 * commit, checkout, sync, and conflict-resolution subviews.
 */
export class ScmPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private repoRoot: string | null = null;
  @state() private statusGroups: ScmStatusResult = {
    changes: [],
    staged: [],
    untracked: [],
    merge: [],
  };
  @state() private selectedPath: string | null = null;
  @state() private diff = "";
  @state() private diffTruncated = false;
  @state() private diffLoading = false;
  @state() private diffError: string | null = null;
  @state() private error: string | null = null;
  @state() private busy = false;
  @state() private lastCommitHash: string | null = null;

  @state() private activeTab: ScmTabKey = "changes";
  @state() private currentBranch: string | null = null;
  @state() private branches: ScmBranch[] = [];
  @state() private ahead: number | null = null;
  @state() private behind: number | null = null;
  @state() private commits: ScmCommitInfo[] = [];
  @state() private conflictPaths: string[] = [];

  private statusClient: GatewayBrowserClient | null = null;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      this.repoRoot = null;
      this.statusGroups = { changes: [], staged: [], untracked: [], merge: [] };
      this.selectedPath = null;
      this.error = null;
      this.currentBranch = null;
      this.branches = [];
      this.commits = [];
      this.conflictPaths = [];
    },
    invalidateRequests: (change) => {
      if (change.snapshot.phase !== "connected" || !change.snapshot.client) {
        this.statusClient = null;
        void this.statusTask.run([null]);
      }
    },
    ensureInitialData: () => void this.load(),
    onSnapshot: () => {},
  });

  private readonly statusTask = new Task(this, {
    autoRun: false,
    args: () => [this.gateway.connected ? this.gateway.client : null] as const,
    task: async ([client], { signal }) => {
      if (!client) {
        return initialState;
      }
      // Resolve the active worktree first, then read its repo status.
      const list = await client.request<WorktreesListResult>("worktrees.list", {}, { signal });
      const worktree = list.worktrees
        .filter((entry) => !entry.removedAt)
        .toSorted((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
      if (!worktree) {
        return { worktree: null, status: null };
      }
      const status = await client.request<ScmStatusResult>(
        "scm.status",
        { repoRoot: worktree.repoRoot },
        { signal },
      );
      return { worktree, status };
    },
    onComplete: (result) => {
      if (!result.worktree) {
        this.repoRoot = null;
        this.statusGroups = { changes: [], staged: [], untracked: [], merge: [] };
        return;
      }
      this.repoRoot = result.worktree.repoRoot;
      this.statusGroups = result.status;
      void this.loadSecondary();
    },
    onError: (error) => {
      this.error = formatUiError(error);
    },
  });

  override disconnectedCallback() {
    this.statusClient = null;
    void this.statusTask.run([null]);
    super.disconnectedCallback();
  }

  private get hasStaged(): boolean {
    return this.statusGroups.staged.length > 0;
  }

  private async load() {
    const client = this.gateway.client;
    if (
      !client ||
      !this.gateway.connected ||
      (this.statusTask.status === TaskStatus.PENDING && this.statusClient === client)
    ) {
      return;
    }
    this.statusClient = client;
    this.error = null;
    await this.statusTask.run([client]);
  }

  /**
   * Refresh the branch/history/conflicts panels after the repo root is known.
   * Each request is best-effort: an individual failure leaves the panel empty
   * rather than failing the whole page.
   */
  private async loadSecondary() {
    const scope = this.gateway.capture();
    const repoRoot = this.repoRoot;
    if (!scope || !repoRoot) {
      return;
    }
    try {
      const branches = await scope.client.request<ScmBranchesResult>("scm.branches", { repoRoot });
      if (this.gateway.isCurrent(scope)) {
        this.branches = branches.branches;
        this.currentBranch = branches.current;
        this.ahead = branches.ahead ?? null;
        this.behind = branches.behind ?? null;
      }
    } catch {
      // Branch list is advisory; leave the panel empty on failure.
    }
    try {
      const log = await scope.client.request<ScmLogResult>("scm.log", { repoRoot });
      if (this.gateway.isCurrent(scope)) {
        this.commits = log.commits;
      }
    } catch {
      // History is advisory.
    }
    try {
      const conflicts = await scope.client.request<ScmConflictsResult>("scm.conflicts", {
        repoRoot,
      });
      if (this.gateway.isCurrent(scope)) {
        this.conflictPaths = conflicts.paths;
      }
    } catch {
      // Conflicts are advisory.
    }
  }

  private async selectFile(path: string) {
    const scope = this.gateway.capture();
    const repoRoot = this.repoRoot;
    if (!scope || !repoRoot) {
      return;
    }
    this.selectedPath = path;
    this.diffLoading = true;
    this.diffError = null;
    this.diff = "";
    this.diffTruncated = false;
    try {
      const result = await scope.client.request<ScmDiffResult>("scm.diff", {
        repoRoot,
        path,
        staged: false,
      });
      if (this.gateway.isCurrent(scope)) {
        this.diff = result.diff;
        this.diffTruncated = result.truncated ?? false;
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.diffError = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.diffLoading = false;
      }
    }
  }

  private async stageOrUnstage(action: "stage" | "unstage", path: string) {
    const scope = this.gateway.capture();
    const repoRoot = this.repoRoot;
    if (!scope || !repoRoot || this.busy) {
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      await scope.client.request(action === "stage" ? "scm.stage" : "scm.unstage", {
        repoRoot,
        paths: [path],
      });
      if (this.gateway.isCurrent(scope)) {
        await this.load();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.busy = false;
      }
    }
  }

  private async commit(message: string) {
    const scope = this.gateway.capture();
    const repoRoot = this.repoRoot;
    if (!scope || !repoRoot || this.busy || !this.hasStaged) {
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      const result = await scope.client.request<ScmCommitResult>("scm.commit", {
        repoRoot,
        message,
      });
      if (this.gateway.isCurrent(scope)) {
        this.lastCommitHash = result.hash;
        this.selectedPath = null;
        this.diff = "";
        await this.load();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.busy = false;
      }
    }
  }

  private async checkout(branch: string) {
    const scope = this.gateway.capture();
    const repoRoot = this.repoRoot;
    if (!scope || !repoRoot || this.busy) {
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      await scope.client.request("scm.checkout", { repoRoot, branch });
      if (this.gateway.isCurrent(scope)) {
        await this.load();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.busy = false;
      }
    }
  }

  private async checkoutNew(name: string) {
    const scope = this.gateway.capture();
    const repoRoot = this.repoRoot;
    if (!scope || !repoRoot || this.busy) {
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      await scope.client.request("scm.checkoutNew", { repoRoot, name });
      if (this.gateway.isCurrent(scope)) {
        await this.load();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.busy = false;
      }
    }
  }

  private async sync(action: "fetch" | "pull" | "push") {
    const scope = this.gateway.capture();
    const repoRoot = this.repoRoot;
    if (!scope || !repoRoot || this.busy) {
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      await scope.client.request(`scm.${action}`, { repoRoot });
      if (this.gateway.isCurrent(scope)) {
        await this.load();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.busy = false;
      }
    }
  }

  private async resolve(path: string, resolution: "theirs" | "ours") {
    const scope = this.gateway.capture();
    const repoRoot = this.repoRoot;
    if (!scope || !repoRoot || this.busy) {
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      await scope.client.request("scm.resolve", { repoRoot, path, resolution });
      if (this.gateway.isCurrent(scope)) {
        await this.load();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.busy = false;
      }
    }
  }

  private onScmAction(event: Event) {
    const detail = (event as CustomEvent).detail as { action: "stage" | "unstage"; path: string };
    void this.stageOrUnstage(detail.action, detail.path);
  }

  private onScmSelect(event: Event) {
    const detail = (event as CustomEvent).detail as { path: string };
    void this.selectFile(detail.path);
  }

  private onScmCommit(event: Event) {
    const detail = (event as CustomEvent).detail as { message: string };
    void this.commit(detail.message);
  }

  private onScmCheckout(event: Event) {
    const detail = (event as CustomEvent).detail as { branch: string };
    void this.checkout(detail.branch);
  }

  private onScmCheckoutNew(event: Event) {
    const detail = (event as CustomEvent).detail as { name: string };
    void this.checkoutNew(detail.name);
  }

  private onScmSync(event: Event) {
    const detail = (event as CustomEvent).detail as { action: "fetch" | "pull" | "push" };
    void this.sync(detail.action);
  }

  private onScmResolve(event: Event) {
    const detail = (event as CustomEvent).detail as { path: string; resolution: "theirs" | "ours" };
    void this.resolve(detail.path, detail.resolution);
  }

  private renderHeader() {
    return html`
      <div class="scm-page__header">
        <span class="scm-page__repo" title=${this.repoRoot ?? ""}>${this.repoRoot}</span>
        ${
          this.currentBranch
            ? html`<span class="scm-page__branch">${this.currentBranch}</span>`
            : html``
        }
      </div>
    `;
  }

  private renderTabs() {
    return html`
      <div class="scm-page__tabs" role="tablist">
        ${SCM_TABS.map(
          (tab) => html`
            <button
              type="button"
              role="tab"
              class="scm-page__tab${this.activeTab === tab.key ? " scm-page__tab--active" : ""}"
              aria-selected=${this.activeTab === tab.key ? "true" : "false"}
              @click=${() => {
                this.activeTab = tab.key;
              }}
            >
              ${t(tab.labelKey)}
              ${
                tab.key === "conflicts" && this.conflictPaths.length > 0
                  ? html`<span class="scm-page__tab-badge">${this.conflictPaths.length}</span>`
                  : html``
              }
            </button>
          `,
        )}
      </div>
    `;
  }

  private renderChangesTab() {
    return html`
      <div class="scm-page__layout">
        <div class="scm-page__changes">
          <openclaw-scm-changes-tree
            .status=${this.statusGroups}
            .selectedPath=${this.selectedPath}
          ></openclaw-scm-changes-tree>
        </div>
        <div class="scm-page__detail">
          <openclaw-scm-diff-view
            .path=${this.selectedPath}
            .diff=${this.diff}
            .truncated=${this.diffTruncated}
            .loading=${this.diffLoading}
            .error=${this.diffError}
          ></openclaw-scm-diff-view>
          <openclaw-scm-commit-box
            .hasStaged=${this.hasStaged}
            .committing=${this.busy}
            .lastCommitHash=${this.lastCommitHash}
          ></openclaw-scm-commit-box>
        </div>
      </div>
    `;
  }

  private renderSecondaryTab() {
    switch (this.activeTab) {
      case "branches":
        return html`
          <openclaw-scm-branches
            .branches=${this.branches}
            .current=${this.currentBranch}
            .ahead=${this.ahead}
            .behind=${this.behind}
            .busy=${this.busy}
          ></openclaw-scm-branches>
        `;
      case "history":
        return html`<openclaw-scm-history .commits=${this.commits}></openclaw-scm-history>`;
      case "conflicts":
        return html`
          <openclaw-scm-conflicts
            .paths=${this.conflictPaths}
            .busy=${this.busy}
          ></openclaw-scm-conflicts>
        `;
      default:
        return this.renderChangesTab();
    }
  }

  override render() {
    return html`
      <div
        class="scm-page scm-page--embedded"
        @scm-action=${(e: Event) => this.onScmAction(e)}
        @scm-select=${(e: Event) => this.onScmSelect(e)}
        @scm-commit=${(e: Event) => this.onScmCommit(e)}
        @scm-checkout=${(e: Event) => this.onScmCheckout(e)}
        @scm-checkout-new=${(e: Event) => this.onScmCheckoutNew(e)}
        @scm-sync=${(e: Event) => this.onScmSync(e)}
        @scm-resolve=${(e: Event) => this.onScmResolve(e)}
      >
        ${this.error ? html`<div class="callout danger" role="alert">${this.error}</div>` : html``}
        ${this.renderHeader()} ${this.renderTabs()}
        <div class="scm-page__content">${this.renderSecondaryTab()}</div>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-scm-page")) {
  customElements.define("openclaw-scm-page", ScmPage);
}
