import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type {
  ScmCommitResult,
  ScmDiffResult,
  ScmStatusFile,
  WorktreeRecord,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import "../../styles/scm.css";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "./scm-changes-tree.ts";
import "./scm-commit-box.ts";
import "./scm-diff-view.ts";

type WorktreesListResult = { worktrees: WorktreeRecord[] };
type ScmStatusResult = {
  changes: ScmStatusFile[];
  staged: ScmStatusFile[];
  untracked: ScmStatusFile[];
  merge: ScmStatusFile[];
};

/**
 * Source Control panel container. Resolves the active worktree via
 * worktrees.list (latest `lastActiveAt`, not removed), then drives scm.status
 * and coordinates the diff preview, stage/unstage, and commit subviews.
 */
class ScmPage extends OpenClawLightDomElement {
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

  private statusClient: GatewayBrowserClient | null = null;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      this.repoRoot = null;
      this.statusGroups = { changes: [], staged: [], untracked: [], merge: [] };
      this.selectedPath = null;
      this.error = null;
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

  private onScmAction(event: Event) {
    // SAFETY: the openclaw-scm-changes-tree child dispatches this event with this detail.
    const detail = (event as CustomEvent).detail as { action: "stage" | "unstage"; path: string };
    void this.stageOrUnstage(detail.action, detail.path);
  }

  private onScmSelect(event: Event) {
    // SAFETY: the openclaw-scm-changes-tree child dispatches this event with this detail.
    const detail = (event as CustomEvent).detail as { path: string };
    void this.selectFile(detail.path);
  }

  private onScmCommit(event: Event) {
    // SAFETY: the openclaw-scm-commit-box child dispatches this event with this detail.
    const detail = (event as CustomEvent).detail as { message: string };
    void this.commit(detail.message);
  }

  override render() {
    const body = html`
      <div
        class="scm-page"
        @scm-action=${this.onScmAction}
        @scm-select=${this.onScmSelect}
        @scm-commit=${this.onScmCommit}
      >
        ${this.error ? html`<div class="callout danger" role="alert">${this.error}</div>` : html``}
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
      </div>
    `;
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("source-control")}</div>
          <div class="page-subtitle">${subtitleForRoute("source-control")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(body, { fillHeight: true })}
    `;
  }
}

if (!customElements.get("openclaw-scm-page")) {
  customElements.define("openclaw-scm-page", ScmPage);
}
