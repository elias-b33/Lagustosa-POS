package se.restaurant.nativepos.smoke;

import static org.junit.Assert.*;

import android.content.Context;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.*;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Separate process and dependency graph: the tested APK is exactly the distributed R8 build. */
@RunWith(AndroidJUnit4.class)
public class OptimizedApkTest {
  private final UiDevice device =
      UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
  private static final String APP = "se.restaurant.nativepos.test";

  private UiObject2 find(String description) {
    UiObject2 object = device.wait(Until.findObject(By.desc(description)), 15000);
    assertNotNull(description, object);
    return object;
  }

  private void tap(String description) {
    find(description).click();
    device.waitForIdle(1000);
  }

  private void text(String value) {
    UiObject2 object = device.wait(Until.findObject(By.text(value)), 15000);
    assertNotNull(value, object);
    object.click();
    device.waitForIdle(1000);
  }

  private void positive() {
    UiObject2 object = device.wait(Until.findObject(By.res("android:id/button1")), 10000);
    assertNotNull(object);
    object.click();
    device.waitForIdle(1000);
  }

  private void closeKeyboard() {
    if (device.findObject(By.pkg("com.android.inputmethod.latin")) != null) device.pressBack();
  }

  private JSONObject probe(String endpoint) throws Exception {
    HttpURLConnection c =
        (HttpURLConnection)
            new URL("http://10.0.2.2:4196/api/v1/__native_test/" + endpoint).openConnection();
    c.setConnectTimeout(5000);
    c.setReadTimeout(10000);
    try (InputStream input = c.getInputStream();
        ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[4096];
      int n;
      while ((n = input.read(buffer)) != -1) out.write(buffer, 0, n);
      return new JSONObject(out.toString("UTF-8"));
    } finally {
      c.disconnect();
    }
  }

  private void screenshot(String name) {
    Context context = InstrumentationRegistry.getInstrumentation().getContext();
    device.takeScreenshot(new File(context.getExternalFilesDir(null), name));
  }

  @Test
  public void optimizedInstallationSaleRecoveryAndFrames() throws Exception {
    assertTrue(probe("stats").has("commands"));
    // Explicitly isolated native test package. Never clears the original hybrid APK.
    assertTrue(device.executeShellCommand("pm clear " + APP).contains("Success"));
    device.executeShellCommand("am start -n " + APP + "/se.restaurant.nativepos.MainActivity");
    find("Kassaserver").setText("http://10.0.2.2:4196");
    find("Enhetskod").setText(probe("config").getString("deviceCode"));
    closeKeyboard();
    tap("Anslut kassan");
    find("PIN-kod").setText("1234");
    tap("Börja servicen");
    find("Ingen nota vald");
    tap("Kassa");
    find("Artikelmeny");
    if (device.findObject(By.desc("Öppna dagen för att börja ta beställningar")) != null) {
      tap("Öppna dagen för att börja ta beställningar");
      tap("Öppna dagen");
      positive();
      SystemClock.sleep(500);
      tap("Kassa");
    }
    tap("+ Ny nota");
    positive();
    SystemClock.sleep(600);
    String productName = probe("config").getString("productName");
    find("Sök i menyn").setText(productName);
    closeKeyboard();
    UiObject2 product = device.wait(Until.findObject(By.descStartsWith(productName + ",")), 15000);
    assertNotNull(product);
    product.click();
    positive();
    SystemClock.sleep(600);
    probe("drop-next");
    product = device.wait(Until.findObject(By.descStartsWith(productName + ",")), 10000);
    product.click();
    positive();
    assertNotNull(device.wait(Until.findObject(By.text("Återuppta samma försök")), 20000));
    device.executeShellCommand("am force-stop " + APP);
    device.executeShellCommand("am start -n " + APP + "/se.restaurant.nativepos.MainActivity");
    assertNotNull(device.wait(Until.findObject(By.text("Återuppta samma försök")), 20000));
    probe("release");
    text("Återuppta samma försök");
    assertTrue(device.wait(Until.gone(By.text("Återuppta samma försök")), 15000));
    UiObject2 saved = device.wait(Until.findObject(By.descStartsWith("Disk ")), 15000);
    assertNotNull(saved);
    saved.click();
    find("Artikelmeny");
    tap("Visa nota");
    tap("Skicka till kök & bar");
    SystemClock.sleep(700);
    tap("Ta betalt");
    positive();
    assertNotNull(device.wait(Until.findObject(By.text("Betalningen är godkänd")), 15000));
    screenshot("native-payment.png");
    UiObject2 close = device.wait(Until.findObject(By.res("android:id/button2")), 10000);
    assertNotNull(close);
    close.click();
    tap("‹ Till menyn");
    assertTrue(device.wait(Until.gone(By.desc("Visa nota")), 5000));
    probe("seed-stress");
    long deadline = SystemClock.uptimeMillis() + 120000;
    JSONObject seeded;
    do {
      seeded = probe("seed-status");
      if (seeded.has("error")) fail(seeded.getString("error"));
      if (!seeded.optBoolean("ready")) SystemClock.sleep(300);
    } while (!seeded.optBoolean("ready") && SystemClock.uptimeMillis() < deadline);
    assertTrue(seeded.optBoolean("ready"));
    find("Sök i menyn").setText("");
    closeKeyboard();
    device.waitForIdle(1500);
    UiObject2 menu = find("Artikelmeny");
    android.graphics.Rect bounds = menu.getVisibleBounds();
    // Warm RecyclerView and rendering before measuring scrolling itself.
    device.swipe(bounds.centerX(), bounds.bottom - 25, bounds.centerX(), bounds.top + 25, 35);
    device.swipe(bounds.centerX(), bounds.top + 25, bounds.centerX(), bounds.bottom - 25, 35);
    tap("⋮");
    text("Mät prestanda");
    SystemClock.sleep(1800);
    for (int i = 0; i < 6; i++)
      device.swipe(bounds.centerX(), bounds.bottom - 25, bounds.centerX(), bounds.top + 25, 35);
    for (int i = 0; i < 6; i++)
      device.swipe(bounds.centerX(), bounds.top + 25, bounds.centerX(), bounds.bottom - 25, 35);
    screenshot("native-handheld.png");
    device.pressHome();
    SystemClock.sleep(800);
    device.executeShellCommand(
        "cp /sdcard/Android/data/"
            + APP
            + "/files/diagnostics/frames.json /sdcard/native-frames-scroll.json");
    device.executeShellCommand("am start -n " + APP + "/se.restaurant.nativepos.MainActivity");
    find("Artikelmeny");
    try {
      device.executeShellCommand("wm size 1280x800");
      device.executeShellCommand("wm density 160");
      device.waitForIdle(2000);
      find("Aktuell nota");
      screenshot("native-counter.png");
    } finally {
      device.executeShellCommand("wm size reset");
      device.executeShellCommand("wm density reset");
    }
    ByteArrayOutputStream hierarchy = new ByteArrayOutputStream();
    device.dumpWindowHierarchy(hierarchy);
    assertFalse(hierarchy.toString("UTF-8").contains("android.webkit.WebView"));
  }
}
