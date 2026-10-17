package se.restaurant.nativepos;

import static org.junit.Assert.*;

import org.json.*;
import org.junit.Test;

public class SnapshotTest {
  private JSONObject fixture() {
    return Json.obj(
        "menu",
        new JSONArray()
            .put(
                Json.obj(
                    "id",
                    "soda",
                    "name",
                    "Läsk",
                    "priceOre",
                    2500,
                    "category",
                    "Dryck",
                    "available",
                    true)),
        "tabs",
        new JSONArray()
            .put(
                Json.obj(
                    "id",
                    "t1",
                    "discountBps",
                    0,
                    "lines",
                    new JSONArray()
                        .put(Json.obj("status", "sent", "quantity", 2, "unitPriceOre", 2500)))));
  }

  @Test
  public void orderChangesReuseTheEntireMenuModel() {
    JSONObject value = fixture();
    Snapshot old = new Snapshot(value, null);
    JSONObject next = Json.copy(value);
    Json.put(
        next,
        "payments",
        new JSONArray()
            .put(Json.obj("kind", "sale", "status", "approved", "tabId", "t1", "amountOre", 1000)));
    Snapshot updated = new Snapshot(next, old);
    assertSame(old.products, updated.products);
    assertSame(old.categories, updated.categories);
    assertEquals(4000, updated.remaining(updated.tab("t1")));
  }

  @Test
  public void priceChangesInvalidateMenuEvenIfNoVersionFieldChanges() {
    JSONObject value = fixture();
    Snapshot before = new Snapshot(value, null);
    JSONObject changed = Json.copy(value);
    Json.put(Json.list(changed, "menu").get(0), "priceOre", 3000);
    Snapshot after = new Snapshot(changed, before);
    assertNotSame(before.products, after.products);
    assertEquals("30 kr", after.products.get(0).price);
  }

  @Test
  public void pendingPaymentLocksTabButIsNotCountedAsPaid() {
    JSONObject value = fixture();
    Json.put(
        value,
        "payments",
        new JSONArray()
            .put(Json.obj("kind", "sale", "status", "unknown", "tabId", "t1", "amountOre", 1000)));
    Snapshot s = new Snapshot(value, null);
    assertTrue(s.lockedTabs.contains("t1"));
    assertEquals(5000, s.remaining(s.tab("t1")));
  }
}
