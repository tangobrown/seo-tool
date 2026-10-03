import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "seo-autopilot" });

export const EVENTS = {
  batchApproved: "batch.approved",
  fakeExecutorStart: "fake-executor.start",
  clientOnboard: "client.onboard",
  clientActivated: "client.activated",
} as const;
