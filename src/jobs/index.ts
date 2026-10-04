import { batchDispatch, batchSweep } from "./batch";
import { fakeExecutor } from "./fake-executor";
import { deploymentVerify, githubBatch, githubReconcile } from "./github";
import { clientOnboard } from "./onboard";
import { clientScan, scanOnActivation, scanSchedule } from "./scan";
import { siteguruSyncClient, siteguruSyncDaily } from "./siteguru";

export const functions = [batchDispatch, batchSweep, fakeExecutor, clientOnboard, siteguruSyncDaily, siteguruSyncClient, clientScan, scanSchedule, scanOnActivation, githubBatch, deploymentVerify, githubReconcile];
