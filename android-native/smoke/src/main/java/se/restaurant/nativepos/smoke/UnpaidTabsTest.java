package se.restaurant.nativepos.smoke;

import static org.junit.Assert.*;

import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.*;
import java.io.*;
import java.net.*;
import java.util.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises the distributed APK against an explicitly configured, isolated training server. */
@RunWith(AndroidJUnit4.class)
public class UnpaidTabsTest {
  private static final String APP = "se.restaurant.nativepos.test";
  private final UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
  private final String origin = InstrumentationRegistry.getArguments().getString("server", "http://10.0.2.2:4196");
  private final String code = InstrumentationRegistry.getArguments().getString("deviceCode", "LAGUSTOSA-TEST");
  private String cookie;

  private JSONObject request(String route, JSONObject body) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(origin + "/api/v1" + route).openConnection();
    c.setConnectTimeout(5000);
    c.setReadTimeout(10000);
    if (cookie != null) c.setRequestProperty("Cookie", cookie);
    if (body != null) {
      c.setRequestMethod("POST");
      c.setDoOutput(true);
      c.setRequestProperty("Content-Type", "application/json");
      try (OutputStream out = c.getOutputStream()) { out.write(body.toString().getBytes("UTF-8")); }
    }
    try {
      assertEquals(route, 200, c.getResponseCode());
      if (route.equals("/auth/login")) cookie = c.getHeaderField("Set-Cookie").split(";")[0];
      try (InputStream input = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
        byte[] buffer = new byte[4096];
        int count;
        while ((count = input.read(buffer)) != -1) out.write(buffer, 0, count);
        return new JSONObject(out.toString("UTF-8"));
      }
    } finally { c.disconnect(); }
  }

  private UiObject2 find(BySelector selector) {
    UiObject2 result = device.wait(Until.findObject(selector), 15000);
    assertNotNull(selector.toString(), result);
    return result;
  }

  private void tap(String description) {
    find(By.desc(description)).click();
    device.waitForIdle(1000);
  }

  private void positive() {
    find(By.res("android:id/button1")).click();
    device.waitForIdle(1000);
  }

  private void hideKeyboard() {
    if (device.findObject(By.pkg("com.android.inputmethod.latin")) != null) device.pressBack();
  }

  private Set<String> tabIds() throws Exception {
    Set<String> ids = new HashSet<>();
    JSONArray tabs = request("/bootstrap", null).getJSONArray("tabs");
    for (int i = 0; i < tabs.length(); i++) ids.add(tabs.getJSONObject(i).getString("id"));
    return ids;
  }

  private JSONObject tab(String id) throws Exception {
    JSONArray tabs = request("/bootstrap", null).getJSONArray("tabs");
    for (int i = 0; i < tabs.length(); i++) {
      JSONObject t = tabs.getJSONObject(i);
      if (t.getString("id").equals(id)) return t;
    }
    throw new AssertionError("Missing saved tab " + id);
  }

  private JSONObject createTab() throws Exception {
    Set<String> before = tabIds();
    tap("+ Ny nota");
    positive();
    for (int attempt = 0; attempt < 40; attempt++) {
      JSONArray tabs = request("/bootstrap", null).getJSONArray("tabs");
      for (int i = 0; i < tabs.length(); i++) {
        JSONObject t = tabs.getJSONObject(i);
        if (!before.contains(t.getString("id"))) {
          find(By.textStartsWith(t.getString("label") + " ·"));
          return t;
        }
      }
      SystemClock.sleep(250);
    }
    throw new AssertionError("New tab was not saved");
  }

  private JSONObject awaitLines(String id, int active) throws Exception {
    for (int attempt = 0; attempt < 40; attempt++) {
      JSONObject saved = tab(id);
      int count = 0;
      JSONArray lines = saved.getJSONArray("lines");
      for (int i = 0; i < lines.length(); i++) if (!lines.getJSONObject(i).getString("status").equals("void")) count++;
      if (count == active) return saved;
      SystemClock.sleep(250);
    }
    throw new AssertionError("Incorrect active row count on " + id);
  }

  private void addCola(String tabId) throws Exception {
    find(By.desc("Sök i menyn")).setText("Cola");
    hideKeyboard();
    device.waitForIdle(1000);
    if (device.findObject(By.descStartsWith("Cola,")) == null) {
      new UiScrollable(new UiSelector().description("Artikelmeny"))
          .scrollIntoView(new UiSelector().descriptionStartsWith("Cola,"));
    }
    find(By.descStartsWith("Cola,")).click();
    positive();
    awaitLines(tabId, 1);
  }

  private void showOrder() {
    UiObject2 cart = device.findObject(By.desc("Visa nota"));
    if (cart != null) cart.click();
    find(By.desc("Aktuell nota"));
  }

  private void menu() {
    UiObject2 back = device.findObject(By.desc("‹ Till menyn"));
    if (back != null) back.click();
    find(By.desc("Artikelmeny"));
  }

  private void selectTab(String label) {
    menu();
    tap("Välj nota");
    find(By.textStartsWith(label + " ·")).click();
    device.waitForIdle(1000);
  }

  private void removeCola(String tabId) throws Exception {
    showOrder();
    find(By.descStartsWith("1 × Cola,")).click();
    find(By.text("Ta bort artikel")).click();
    find(By.desc("Orsak")).setText("Feltryck vid test");
    hideKeyboard();
    positive();
    awaitLines(tabId, 0);
    assertTrue(device.wait(Until.gone(By.descStartsWith("1 × Cola,")), 15000));
  }

  private void assertUnpaid(String id) throws Exception {
    assertEquals("open", tab(id).getString("status"));
    JSONArray payments = request("/bootstrap", null).getJSONArray("payments");
    for (int i = 0; i < payments.length(); i++) assertNotEquals("Saving/switching must never start payment", id, payments.getJSONObject(i).optString("tabId"));
  }

  @Test
  public void leaveSwitchRemoveAndReopenUnpaidCounterTabs() throws Exception {
    assertEquals("training", request("/health", null).getString("mode"));
    request("/auth/login", new JSONObject().put("staffId", "admin").put("pin", "1234").put("deviceCode", code));
    device.executeShellCommand("am start -n " + APP + "/se.restaurant.nativepos.MainActivity");
    device.waitForIdle(1000);
    UiObject2 server = device.wait(Until.findObject(By.desc("Kassaserver")), 5000);
    if (server != null) {
      server.setText(origin);
      find(By.desc("Enhetskod")).setText(code);
      hideKeyboard();
      tap("Anslut kassan");
    }
    UiObject2 pin = device.wait(Until.findObject(By.desc("PIN-kod")), 5000);
    if (pin != null) {
      pin.setText("1234");
      tap("Börja servicen");
    }
    find(By.desc("Artikelmeny"));
    if (device.findObject(By.desc("Öppna dagen för att börja ta beställningar")) != null) {
      tap("Öppna dagen för att börja ta beställningar");
      tap("Öppna dagen");
      positive();
      SystemClock.sleep(500);
      tap("Kassa");
    }
    JSONObject first = createTab();
    String a = first.getString("id"), label = first.getString("label");
    addCola(a);
    JSONObject second = createTab();
    String b = second.getString("id");
    addCola(b);
    assertUnpaid(a);
    assertUnpaid(b);
    selectTab(label);
    removeCola(a);
    assertEquals("draft", tab(b).getJSONArray("lines").getJSONObject(0).getString("status"));
    menu();
    addCola(a);
    showOrder();
    tap("Skicka till kök & bar");
    find(By.descContains("Gäst 1 · Skickad"));
    removeCola(a);
    menu();
    addCola(a);
    tap("Bord");
    if (device.findObject(By.text(label)) == null) {
      new UiScrollable(new UiSelector().description("Bord").scrollable(true))
          .scrollIntoView(new UiSelector().text(label));
    }
    find(By.text(label)).click();
    find(By.desc("Artikelmeny"));
    device.executeShellCommand("am force-stop " + APP);
    device.executeShellCommand("am start -n " + APP + "/se.restaurant.nativepos.MainActivity");
    find(By.desc("Artikelmeny"));
    find(By.textStartsWith(label + " ·"));
    showOrder();
    find(By.descStartsWith("1 × Cola,"));
    assertUnpaid(a);
    assertUnpaid(b);
    assertEquals(3, tab(a).getJSONArray("lines").length());
    device.takeScreenshot(new File(InstrumentationRegistry.getInstrumentation().getContext().getExternalFilesDir(null), "unpaid-tab.png"));
    menu();
    find(By.desc("Sök i menyn")).setText("");
    hideKeyboard();
    System.out.println("Unpaid tabs verified: " + label + " and " + second.getString("label") + "; draft and sent rows removed; app restart preserved both; zero payments.");
  }
}
