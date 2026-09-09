import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("source-control"),
  component: () =>
    import("./scm-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-scm-page></openclaw-scm-page>`,
    })),
});
