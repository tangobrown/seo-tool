import { batchDispatch, batchSweep } from "./batch";
import { blogCommitmentCheck, blogDraftClient, blogDraftWeekly, blogPlanClient, blogPlanMonthly, blogPlanOnActivation } from "./blog";
import { fakeExecutor } from "./fake-executor";
import { deploymentVerify, githubBatch, githubReconcile } from "./github";
import { clientOnboard } from "./onboard";
import { reportMonthly } from "./reports";
import { clientScan, scanOnActivation, scanSchedule } from "./scan";
import { siteguruSyncClient, siteguruSyncDaily } from "./siteguru";

export const functions = [batchDispatch, batchSweep, fakeExecutor, clientOnboard, siteguruSyncDaily, siteguruSyncClient, clientScan, scanSchedule, scanOnActivation, githubBatch, deploymentVerify, githubReconcile, reportMonthly, blogPlanClient, blogPlanMonthly, blogDraftClient, blogDraftWeekly, blogCommitmentCheck, blogPlanOnActivation];
