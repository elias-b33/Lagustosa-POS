package se.restaurant.nativepos;

import static org.junit.Assert.*;
import java.util.*;
import org.json.JSONObject;
import org.junit.Test;

public class TableLookupTest {
  @Test public void leadingZerosAndConfiguredNamesMatchWithoutGuessingIds() {
    JSONObject table = Json.obj("id", "random-id", "name", "Bord 007", "active", true);
    assertSame(table, TableLookup.matching(Arrays.asList(table), "7").get(0));
    assertSame(table, TableLookup.matching(Arrays.asList(table), "0007").get(0));
    assertTrue(TableLookup.matching(Arrays.asList(table), "8").isEmpty());
    assertEquals("", TableLookup.number("Bord 7-8"));
    assertEquals("", TableLookup.number("999999999999999999"));
    assertEquals("", TableLookup.number(""));
  }
  @Test public void duplicateNumbersNeedAreaSelectionAndInactiveTablesAreExcluded() {
    List<JSONObject> tables = Arrays.asList(
        Json.obj("id", "a", "name", "Bord 1", "active", true, "area", "Inne"),
        Json.obj("id", "b", "name", "01", "active", true, "area", "Ute"),
        Json.obj("id", "c", "name", "1", "active", false));
    assertEquals(2, TableLookup.matching(tables, "1").size());
  }
  @Test public void existingUnpaidTableIsResumedButClosedBillsAreNot() {
    JSONObject open = Json.obj("id", "unpaid", "tableId", "table-a", "status", "open");
    List<JSONObject> tabs = Arrays.asList(Json.obj("id", "paid", "tableId", "table-a", "status", "closed"), open);
    assertSame(open, TableLookup.openTab(tabs, "table-a"));
    assertNull(TableLookup.openTab(tabs, "table-b"));
  }
  @Test public void quantityCommandsGetDurableIdempotencyKeys() {
    String[] saved = {""};
    CommandJournal journal = new CommandJournal(new CommandJournal.Storage() {
      public String read() { return saved[0]; }
      public boolean write(String value) { saved[0] = value; return true; }
    });
    CommandJournal.Pending first = journal.begin("https://example.test", "admin@main", "training", "/native/tabs/a/decrement", "POST", Json.obj("expectedQuantity", 3), "Minska antal");
    assertTrue(first.retryable());
    assertFalse(first.body.optString("key").isEmpty());
    assertEquals(first.body.optString("key"), journal.load().body.optString("key"));
  }
}
