export type RefreshResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function createSnapshotRefresh<T>(load: () => Promise<T>, apply: (result: RefreshResult<T>) => void) {
  let sequence = 0;
  let lastApplied = 0;
  return async () => {
    const current = ++sequence;
    let result: RefreshResult<T>;
    try { result = { ok: true, value: await load() }; }
    catch (error) { result = { ok: false, error }; }
    // Errors must obey the same ordering as snapshots: a delayed 401 must not
    // clear a newer login, nor may old data reappear after a newer logout.
    if (current <= lastApplied) return;
    lastApplied = current;
    apply(result);
  };
}

export function createRefreshScheduler(refresh: () => Promise<unknown>, delay = 80) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let requested = false;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    requested = true;
    if (timer !== null || running) return;
    // Keep the first event's deadline instead of postponing forever during a
    // busy service. A slow fetch gets at most one queued successor.
    timer = setTimeout(() => {
      timer = null;
      requested = false;
      running = true;
      const settled = () => { running = false; if (requested) schedule(); };
      void Promise.resolve().then(refresh).then(settled, settled);
    }, delay);
  };
  return { schedule, stop() { stopped = true; if (timer !== null) clearTimeout(timer); } };
}
