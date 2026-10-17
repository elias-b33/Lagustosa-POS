package se.restaurant.nativepos.smoke;

import static org.junit.Assert.*;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.*;
import java.io.*;
import java.net.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Black-box regression of the exact distributed APK against review-fixture.ts only. */
@RunWith(AndroidJUnit4.class)
public class BugReviewTest {
  private final UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
  private final String origin = InstrumentationRegistry.getArguments().getString("server", "http://127.0.0.1:4202");
  private static final String APP = "se.restaurant.nativepos.test";

  private JSONObject probe(String route, boolean post) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(origin + "/api/v1/__native_review/" + route).openConnection();
    c.setConnectTimeout(5000); c.setReadTimeout(10000);
    if (post) {
      c.setRequestMethod("POST"); c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json");
      try (OutputStream out = c.getOutputStream()) { out.write("{}".getBytes("UTF-8")); }
    }
    try {
      assertEquals(200, c.getResponseCode());
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      try (InputStream in = c.getInputStream()) {
        byte[] bytes = new byte[4096]; int n;
        while ((n = in.read(bytes)) != -1) out.write(bytes, 0, n);
      }
      return new JSONObject(out.toString("UTF-8"));
    } finally { c.disconnect(); }
  }
  private UiObject2 find(BySelector selector) {
    UiObject2 result = device.wait(Until.findObject(selector), 15000);
    assertNotNull(selector.toString(), result); return result;
  }
  private void tap(String desc) { find(By.desc(desc)).click(); device.waitForIdle(1000); }
  private void positive() { find(By.res("android:id/button1")).click(); device.waitForIdle(1000); }
  private void close() { find(By.res("android:id/button2")).click(); device.waitForIdle(1000); }
  private void keyboard() { if (device.findObject(By.pkg("com.android.inputmethod.latin")) != null) device.pressBack(); }
  private void order() {
    UiObject2 show = device.findObject(By.desc("Visa nota")); if (show != null) show.click();
    find(By.desc("Aktuell nota"));
  }
  private void home() {
    UiObject2 leave = device.findObject(By.desc("Lämna nota"));
    if (leave != null) leave.click(); else tap("Start");
    find(By.desc("Ingen nota vald"));
  }
  private void open(String label) throws Exception {
    UiObject2 expand = device.findObject(By.desc("Visa alla öppna notor")); if (expand != null) expand.click();
    if (device.findObject(By.text(label)) == null)
      new UiScrollable(new UiSelector().description("Öppna notor")).scrollIntoView(new UiSelector().text(label));
    find(By.text(label)).click(); find(By.desc("Artikelmeny"));
  }
  private JSONObject value(String type, String id) throws Exception {
    JSONArray values = probe("state", false).getJSONArray(type);
    for (int i = 0; i < values.length(); i++) if (values.getJSONObject(i).getString("id").equals(id)) return values.getJSONObject(i);
    throw new AssertionError("Missing " + type + ":" + id);
  }
  private void ready() throws Exception {
    device.executeShellCommand("am force-stop " + APP);
    device.executeShellCommand("am start -n " + APP + "/se.restaurant.nativepos.MainActivity");
    UiObject2 server = device.wait(Until.findObject(By.desc("Kassaserver")), 2000);
    if (server == null) {
      if (device.findObject(By.desc("PIN-kod")) != null) {
        new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(new UiSelector().description("Anslutning och enhet"));
        tap("Anslutning och enhet");
      } else { tap("⋮"); find(By.text("Anslutning och arbetsyta")).click(); }
      server = find(By.desc("Kassaserver"));
    }
    server.setText(origin); find(By.desc("Enhetskod")).setText("LAGUSTOSA-TEST"); keyboard(); tap("Anslut kassan");
    UiObject2 pin = device.wait(Until.findObject(By.desc("PIN-kod")), 5000);
    if (pin != null) { pin.setText("1234"); tap("Börja servicen"); }
    find(By.desc("Ingen nota vald"));
  }

  @Test public void conflictsKitchenDetailsAndSplitPayments() throws Exception {
    JSONObject setup = probe("prepare", true);
    ready();
    JSONObject conflict = setup.getJSONObject("conflict");
    open(conflict.getString("label")); order(); tap("Ta bort Granskningspasta");
    find(By.desc("Orsak")).setText("Feltryck i isolerat prov"); keyboard();
    probe("arm-conflict", true); positive();
    find(By.text("Avsluta avvisat försök"));
    JSONObject afterConflict = value("tabs", conflict.getString("id"));
    assertEquals("draft", afterConflict.getJSONArray("lines").getJSONObject(0).getString("status"));
    assertEquals(10101, afterConflict.getJSONArray("lines").getJSONObject(0).getInt("unitPriceOre"));
    assertEquals("Must never rebase and submit a second removal", 1, probe("state", false).getInt("removalAttempts"));
    find(By.text("Avsluta avvisat försök")).click(); positive();
    assertTrue(device.wait(Until.gone(By.text("Avsluta avvisat försök")), 10000));
    home(); tap("Kök");
    JSONObject kitchen = setup.getJSONObject("kitchen"), ticket = setup.getJSONObject("kitchenTicket");
    if (device.findObject(By.text(kitchen.getString("label"))) == null)
      new UiScrollable(new UiSelector().description("Kök").scrollable(true)).scrollIntoView(new UiSelector().text(kitchen.getString("label")));
    find(By.text(kitchen.getString("label"))).click();
    find(By.textContains("Glutenfri pasta"));
    find(By.textContains("Utan lök — TEST"));
    assertNull("Voided item must not appear in the detail", device.findObject(By.textContains("Ska makuleras")));
    assertNull("Cannot skip directly from queued to ready", device.findObject(By.desc("Klar")));
    assertNull(device.findObject(By.desc("Serverad")));
    tap("Tillagas");
    for (int i = 0; i < 40 && !value("tickets", ticket.getString("id")).getString("status").equals("started"); i++) SystemClock.sleep(100);
    assertEquals("started", value("tickets", ticket.getString("id")).getString("status"));
    assertNull("Fully cancelled order is no longer an active empty ticket", device.findObject(By.text(setup.getJSONObject("empty").getString("label"))));
    home();
    JSONObject split = setup.getJSONObject("split");
    open(split.getString("label")); order();
    tap("Dela nota"); find(By.text("Dela lika"));
    find(By.desc("Antal delar som återstår")).setText("3"); keyboard(); positive();
    find(By.text("Betalningen är godkänd")); close();
    find(By.text("Kvar  66,67 kr"));
    tap("Dela nota"); find(By.text("Dela lika")); positive();
    find(By.text("Betalningen är godkänd")); close();
    find(By.text("Kvar  33,33 kr"));
    tap("Ta betalt"); positive(); find(By.text("Betalningen är godkänd")); close();
    JSONObject finalTab = value("tabs", split.getString("id")); assertEquals("paid", finalTab.getString("status"));
    JSONArray payments = probe("state", false).getJSONArray("payments");
    int total = 0, count = 0;
    for (int i = 0; i < payments.length(); i++) {
      JSONObject p = payments.getJSONObject(i);
      if (p.getString("tabId").equals(split.getString("id")) && p.getString("status").equals("approved")) { total += p.getInt("amountOre"); count++; }
    }
    assertEquals(3, count); assertEquals(10001, total);
    home();
    // Session expiry must dismiss the stale article form before the login screen is shown.
    open(conflict.getString("label"));
    find(By.desc("Sök i menyn")).setText("Granskningspasta"); keyboard();
    find(By.descStartsWith("Granskningspasta,")).click();
    find(By.desc("Antal"));
    probe("expire-sessions", true);
    find(By.desc("PIN-kod"));
    assertNull(device.findObject(By.desc("Antal")));
    find(By.desc("PIN-kod")).setText("1234"); tap("Börja servicen");
    find(By.desc("Artikelmeny")); home();
  }
}
