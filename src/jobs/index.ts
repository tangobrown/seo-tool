import { batchDispatch, batchSweep } from "./batch";
import { fakeExecutor } from "./fake-executor";
import { clientOnboard } from "./onboard";

export const functions = [batchDispatch, batchSweep, fakeExecutor, clientOnboard];
