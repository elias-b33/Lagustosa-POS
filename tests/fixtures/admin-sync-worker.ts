import { SyncWorker } from "../../portal/sync/worker";
const worker = new SyncWorker(JSON.parse(process.env.ADMIN_TEST_SYNC_CONFIG!));
let stopping = false;
process.on("message", (message) => {
  if (message === "stop") stopping = true;
});
try {
  while (!stopping) {
    try {
      const cursor = await worker.once();
      process.send?.({ ok: true, cursor });
    } catch (error) {
      process.send?.({ ok: false, message: (error as Error).message });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
} finally {
  worker.close();
  process.disconnect?.();
}
