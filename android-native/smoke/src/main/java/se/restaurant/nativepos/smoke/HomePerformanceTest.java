package se.restaurant.nativepos.smoke;

import static org.junit.Assert.*;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.*;

/** Read-only scroll/navigation measurement on an already configured training installation. */
@RunWith(AndroidJUnit4.class)
public class HomePerformanceTest {
  private final UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
  private UiObject2 find(BySelector selector) {
    UiObject2 item = device.wait(Until.findObject(selector), 15000);
    assertNotNull(selector.toString(), item);
    return item;
  }
  private void tap(String label) { find(By.desc(label)).click(); device.waitForIdle(500); }
  @Test public void menuAndOpenBillsRecordFrameDurations() throws Exception {
    device.executeShellCommand("am start -n se.restaurant.nativepos.test/se.restaurant.nativepos.MainActivity");
    tap("Start");
    find(By.desc("Ingen nota vald"));
    tap("Kassa");
    android.graphics.Rect bounds = find(By.desc("Artikelmeny")).getVisibleBounds();
    device.swipe(bounds.centerX(), bounds.bottom - 25, bounds.centerX(), bounds.top + 25, 35);
    device.swipe(bounds.centerX(), bounds.top + 25, bounds.centerX(), bounds.bottom - 25, 35);
    tap("⋮");
    find(By.text("Mät prestanda")).click();
    SystemClock.sleep(1800);
    for (int i = 0; i < 8; i++) {
      device.swipe(bounds.centerX(), bounds.bottom - 25, bounds.centerX(), bounds.top + 25, 35);
      device.swipe(bounds.centerX(), bounds.top + 25, bounds.centerX(), bounds.bottom - 25, 35);
    }
    tap("Lämna nota");
    find(By.desc("Ingen nota vald"));
    UiObject2 expand = device.findObject(By.desc("Visa alla öppna notor"));
    if (expand != null) expand.click();
    bounds = find(By.desc("Öppna notor")).getVisibleBounds();
    for (int i = 0; i < 4; i++) {
      device.swipe(bounds.centerX(), bounds.bottom - 10, bounds.centerX(), bounds.top + 10, 35);
      device.swipe(bounds.centerX(), bounds.top + 10, bounds.centerX(), bounds.bottom - 10, 35);
    }
    ByteArrayOutputStream hierarchy = new ByteArrayOutputStream();
    device.dumpWindowHierarchy(hierarchy);
    assertFalse(hierarchy.toString("UTF-8").contains("android.webkit.WebView"));
    device.pressHome();
    SystemClock.sleep(500);
    device.executeShellCommand("am start -n se.restaurant.nativepos.test/se.restaurant.nativepos.MainActivity");
    find(By.desc("Ingen nota vald"));
  }
}
