import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "seo-autopilot" });

export const EVENTS = {
  batchApproved: "batch.approved",
  fakeExecutorStart: "fake-executor.start",
  clientOnboard: "client.onboard",
  clientActivated: "client.activated",
  siteguruSyncClient: "siteguru.sync.client",
  clientScan: "client.scan",
  githubBatchStart: "github.batch.start",
  deploymentVerify: "deployment.verify",
  reportMonthly: "report.monthly.run",
  blogPlanClient: "blog.plan.client",
  blogDraftClient: "blog.draft.client",
} as const;
