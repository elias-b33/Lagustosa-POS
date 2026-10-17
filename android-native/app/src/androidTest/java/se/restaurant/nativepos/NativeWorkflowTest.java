package se.restaurant.nativepos;

import static org.junit.Assert.*;

import android.content.*;
import android.os.SystemClock;
import android.view.*;
import androidx.recyclerview.widget.RecyclerView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.rule.ActivityTestRule;
import androidx.test.uiautomator.*;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class NativeWorkflowTest {
  @Rule
  public ActivityTestRule<MainActivity> rule =
      new ActivityTestRule<>(MainActivity.class, false, false);

  private UiDevice device;
  private MainActivity activity;
  private String productName;
  private static final String SERVER = "http://10.0.2.2:4196";

  @Before
  public void start() throws Exception {
    device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
    // The test requires our isolated proxy, never an operator's server.
    ApiClient probe = new ApiClient(SERVER, target.getSharedPreferences("test-probe", 0));
    assertTrue(probe.get("/__native_test/stats").has("commands"));
    JSONObject config = probe.get("/__native_test/config");
    productName = config.optString("productName");
    String deviceCode = config.optString("deviceCode");
    activity = rule.launchActivity(new Intent(target, MainActivity.class));
    onMain(
        () -> {
          target.getSharedPreferences("native-pos-sessions", 0).edit().clear().commit();
          activity.controller.preferences.edit().putString("layout", "handheld").apply();
          activity.controller.configure(SERVER, deviceCode);
        });
    await(() -> !activity.controller.checking && !activity.controller.staff.isEmpty(), 15000);
    // Restoring a saved session is asynchronous; a disappearing PIN form is valid.
    long loginDeadline = SystemClock.uptimeMillis() + 15000;
    while (activity.controller.snapshot == null
        && device.findObject(By.desc("PIN-kod")) == null
        && SystemClock.uptimeMillis() < loginDeadline) SystemClock.sleep(50);
    if (activity.controller.snapshot == null) {
      UiObject2 pin = device.findObject(By.desc("PIN-kod"));
      if (pin != null) {
        pin.setText("1234");
        click("Börja servicen");
      }
    }
    await(() -> activity.controller.snapshot != null && activity.controller.online, 15000);
    onMain(() -> activity.navigate("pos"));
  }

  private void onMain(Runnable work) {
    InstrumentationRegistry.getInstrumentation().runOnMainSync(work);
  }

  private void await(BooleanSupplier condition, long timeout) {
    long until = SystemClock.uptimeMillis() + timeout;
    while (!condition.getAsBoolean() && SystemClock.uptimeMillis() < until) SystemClock.sleep(50);
    assertTrue("Timed out: " + activity.controller.error, condition.getAsBoolean());
  }

  private void click(String description) {
    UiObject2 button = device.wait(Until.findObject(By.desc(description)), 10000);
    assertNotNull(description, button);
    button.click();
    device.waitForIdle(1500);
  }

  private void positive() {
    UiObject2 button = device.wait(Until.findObject(By.res("android:id/button1")), 5000);
    assertNotNull(button);
    button.click();
  }

  private void closeKeyboard() {
    if (device.findObject(By.pkg("com.android.inputmethod.latin")) != null) device.pressBack();
  }

  private void waitWrite() {
    await(() -> !activity.controller.busy && activity.controller.pending == null, 15000);
  }

  private long quantity() {
    JSONObject tab = activity.controller.snapshot.tab(activity.selectedTab);
    long n = 0;
    for (JSONObject line : Json.list(tab, "lines"))
      if (!line.optString("status").equals("void")) n += line.optLong("quantity");
    return n;
  }

  @Test
  public void saleAndLostOrderResponseRecoverWithoutDuplicate() throws Exception {
    if (activity.controller.snapshot.day == null) {
      onMain(() -> activity.forms.openDay());
      positive();
      waitWrite();
      await(() -> activity.controller.snapshot.day != null, 10000);
    }
    click("+ Ny nota");
    positive();
    waitWrite();
    await(() -> activity.tab() != null, 10000);
    device.wait(Until.findObject(By.desc("Sök i menyn")), 10000).setText(productName);
    closeKeyboard();
    UiObject2 product = device.wait(Until.findObject(By.descStartsWith(productName + ",")), 10000);
    assertNotNull(product);
    product.click();
    positive();
    waitWrite();
    await(() -> quantity() == 1, 10000);
    ApiClient probe = new ApiClient(SERVER, activity.getSharedPreferences("test-probe", 0));
    probe.get("/__native_test/drop-next");
    product = device.wait(Until.findObject(By.descStartsWith(productName + ",")), 5000);
    product.click();
    positive();
    await(() -> !activity.controller.busy && activity.controller.pending != null, 20000);
    String key = activity.controller.pending.body.optString("key");
    assertFalse(key.isEmpty());
    String saved = activity.getSharedPreferences("native-pos-command", 0).getString("pending", "");
    assertTrue(saved.contains(key));
    await(() -> activity.controller.online && quantity() == 2, 15000);
    rule.finishActivity();
    activity =
        rule.launchActivity(
            new Intent(
                InstrumentationRegistry.getInstrumentation().getTargetContext(),
                MainActivity.class));
    await(() -> activity.controller.online, 15000);
    assertEquals(key, activity.controller.pending.body.optString("key"));
    probe.get("/__native_test/release");
    UiObject2 retry = device.wait(Until.findObject(By.text("Återuppta samma försök")), 10000);
    assertNotNull(retry);
    retry.click();
    waitWrite();
    await(() -> quantity() == 2, 10000);
    click("Visa nota");
    click("Skicka till kök & bar");
    waitWrite();
    await(
        () ->
            Json.list(activity.tab(), "lines").stream()
                .noneMatch(l -> l.optString("status").equals("draft")),
        10000);
    click("Ta betalt");
    positive();
    waitWrite();
    assertNotNull(device.wait(Until.findObject(By.text("Betalningen är godkänd")), 10000));
    await(() -> activity.tab() != null && activity.tab().optString("status").equals("paid"), 10000);
    assertNoBrowser(activity.getWindow().getDecorView());
    screenshot("native-payment.png");
  }

  @Test
  public void recycledMenuRecordsRealFrameDurations() throws Exception {
    ApiClient probe = new ApiClient(SERVER, activity.getSharedPreferences("test-probe", 0));
    assertTrue(probe.get("/__native_test/seed-stress").optBoolean("ok"));
    long until = SystemClock.uptimeMillis() + 120000;
    JSONObject seeded;
    do {
      seeded = probe.get("/__native_test/seed-status");
      if (seeded.has("error")) fail(seeded.optString("error"));
      if (!seeded.optBoolean("ready")) SystemClock.sleep(500);
    } while (!seeded.optBoolean("ready") && SystemClock.uptimeMillis() < until);
    assertTrue("Stress fixture completed", seeded.optBoolean("ready"));
    onMain(
        () -> {
          activity.selectTab("");
          activity.controller.refresh();
        });
    await(() -> activity.controller.snapshot.products.size() >= 300, 30000);
    UiObject2 menu = device.wait(Until.findObject(By.desc("Artikelmeny")), 10000);
    assertNotNull(menu);
    onMain(() -> activity.frames.reset());
    android.graphics.Rect bounds = menu.getVisibleBounds();
    for (int i = 0; i < 6; i++)
      device.swipe(bounds.centerX(), bounds.bottom - 30, bounds.centerX(), bounds.top + 30, 35);
    for (int i = 0; i < 6; i++)
      device.swipe(bounds.centerX(), bounds.top + 30, bounds.centerX(), bounds.bottom - 30, 35);
    UiObject2 search = device.findObject(By.desc("Sök i menyn"));
    search.setText("Testartikel 299");
    device.waitForIdle(1500);
    search.setText("");
    closeKeyboard();
    device.waitForIdle(1500);
    final JSONObject[] metrics = new JSONObject[1];
    onMain(
        () -> {
          RecyclerView recycler =
              (RecyclerView) findDescription(activity.getWindow().getDecorView(), "Artikelmeny");
          ProductAdapter adapter = (ProductAdapter) recycler.getAdapter();
          metrics[0] = activity.frames.report();
          Json.put(metrics[0], "articles", adapter.getItemCount());
          Json.put(metrics[0], "visibleHolders", recycler.getChildCount());
          Json.put(metrics[0], "createdHolders", adapter.createdHolders);
          Json.put(
              metrics[0],
              "environment",
              "Android emulator, 1024 MB RAM, 2 vCPU; not a physical payment terminal");
          assertTrue(
              "Only a bounded number of native cells should exist", adapter.createdHolders < 80);
          assertTrue(recycler.getChildCount() < 40);
        });
    assertTrue(metrics[0].optInt("samples") > 20);
    write("native-frames.json", metrics[0].toString());
    screenshot("native-handheld.png");
    device.setOrientationLeft();
    onMain(
        () -> {
          activity.controller.preferences.edit().putString("layout", "counter").apply();
          activity.rebuild();
        });
    device.waitForIdle(1500);
    screenshot("native-counter.png");
    assertTrue(activity.counter());
    device.setOrientationNatural();
    device.unfreezeRotation();
    assertNoBrowser(activity.getWindow().getDecorView());
  }

  private static View findDescription(View v, String text) {
    if (text.contentEquals(v.getContentDescription() == null ? "" : v.getContentDescription()))
      return v;
    if (v instanceof ViewGroup)
      for (int i = 0; i < ((ViewGroup) v).getChildCount(); i++) {
        View result = findDescription(((ViewGroup) v).getChildAt(i), text);
        if (result != null) return result;
      }
    return null;
  }

  private static void assertNoBrowser(View v) {
    assertFalse(v.getClass().getName().startsWith("android.webkit."));
    if (v instanceof ViewGroup)
      for (int i = 0; i < ((ViewGroup) v).getChildCount(); i++)
        assertNoBrowser(((ViewGroup) v).getChildAt(i));
  }

  private void write(String name, String text) throws Exception {
    File file = new File(activity.getExternalFilesDir(null), name);
    try (FileOutputStream out = new FileOutputStream(file)) {
      out.write(text.getBytes(StandardCharsets.UTF_8));
    }
  }

  private void screenshot(String name) {
    device.takeScreenshot(new File(activity.getExternalFilesDir(null), name));
  }
}
