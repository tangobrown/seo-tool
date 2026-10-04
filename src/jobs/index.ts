import { batchDispatch, batchSweep } from "./batch";
import { fakeExecutor } from "./fake-executor";
import { clientOnboard } from "./onboard";
import { siteguruSyncClient, siteguruSyncDaily } from "./siteguru";

export const functions = [batchDispatch, batchSweep, fakeExecutor, clientOnboard, siteguruSyncDaily, siteguruSyncClient];
