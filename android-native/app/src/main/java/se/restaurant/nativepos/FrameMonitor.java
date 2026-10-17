package se.restaurant.nativepos;

import android.os.Handler;
import android.os.HandlerThread;
import android.view.FrameMetrics;
import android.view.Window;
import java.util.Arrays;
import org.json.JSONObject;

/** Actual HWUI frame durations; no continuous redraw loop, and no FPS claims from idle time. */
public final class FrameMonitor implements Window.OnFrameMetricsAvailableListener {
  private final HandlerThread thread = new HandlerThread("native-frame-metrics");
  private final long[] samples = new long[20000];
  private int count, dropped;
  private final Window window;

  public FrameMonitor(Window window) {
    this.window = window;
    thread.start();
    window.addOnFrameMetricsAvailableListener(this, new Handler(thread.getLooper()));
  }

  @Override
  public synchronized void onFrameMetricsAvailable(Window w, FrameMetrics frame, int lost) {
    dropped += lost;
    if (frame.getMetric(FrameMetrics.FIRST_DRAW_FRAME) == 1) return;
    if (count < samples.length) samples[count++] = frame.getMetric(FrameMetrics.TOTAL_DURATION);
  }

  public synchronized void reset() {
    count = 0;
    dropped = 0;
  }

  public synchronized JSONObject report() {
    long[] sorted = Arrays.copyOf(samples, count);
    Arrays.sort(sorted);
    int over16 = 0, over33 = 0;
    for (long value : sorted) {
      if (value > 16_666_667L) over16++;
      if (value > 33_333_333L) over33++;
    }
    return Json.obj(
        "metric",
        "Android HWUI TOTAL_DURATION; first-draw frames excluded",
        "samples",
        count,
        "droppedMetrics",
        dropped,
        "p50Ms",
        percentile(sorted, .50),
        "p95Ms",
        percentile(sorted, .95),
        "p99Ms",
        percentile(sorted, .99),
        "framesOver16_7ms",
        over16,
        "framesOver33_3ms",
        over33,
        "device",
        android.os.Build.MODEL,
        "androidApi",
        android.os.Build.VERSION.SDK_INT,
        "physicalTerminalVerified",
        false);
  }

  private static double percentile(long[] sorted, double p) {
    return sorted.length == 0
        ? 0
        : sorted[Math.max(0, (int) Math.ceil(sorted.length * p) - 1)] / 1_000_000.0;
  }

  public void close() {
    window.removeOnFrameMetricsAvailableListener(this);
    thread.quitSafely();
  }
}
