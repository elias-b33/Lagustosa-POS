package se.restaurant.nativepos;

import static org.junit.Assert.*;

import org.json.JSONObject;
import org.junit.Test;

public class CommandJournalTest {
  private static class Memory implements CommandJournal.Storage {
    String text = "";
    boolean available = true;

    public String read() {
      return text;
    }

    public boolean write(String value) {
      if (!available) return false;
      text = value;
      return true;
    }
  }

  @Test
  public void lostResponseAndProcessRestartKeepTheSameKeyAndPayload() {
    Memory disk = new Memory();
    CommandJournal before = new CommandJournal(disk);
    JSONObject input = Json.obj("action", "add", "version", 1, "itemId", "soda", "quantity", 1);
    CommandJournal.Pending sent =
        before.begin(
            "https://pos.example",
            "alice:main",
            "round1",
            "/tabs/t1/commands",
            "POST",
            input,
            "Lägg till läsk");
    String wire = sent.body.toString();
    CommandJournal after = new CommandJournal(disk);
    CommandJournal.Pending retried = after.load();
    assertEquals(wire, retried.body.toString());
    assertFalse(retried.body.optString("key").isEmpty());
    assertTrue(retried.retryable());
    assertThrows(
        IllegalStateException.class,
        () ->
            after.begin(
                "https://pos.example",
                "alice:main",
                "round1",
                "/tabs/t1/commands",
                "POST",
                input,
                "Nytt försök"));
    assertEquals(wire, after.load().body.toString());
    after.clear();
    assertNull(after.load());
  }

  @Test
  public void storageFailurePreventsStartingAWritableAttempt() {
    Memory disk = new Memory();
    disk.available = false;
    CommandJournal journal = new CommandJournal(disk);
    assertThrows(
        IllegalStateException.class,
        () ->
            journal.begin(
                "https://pos.example",
                "a:b",
                "",
                "/tabs",
                "POST",
                Json.obj("guestCount", 1),
                "Ny nota"));
    assertEquals("", disk.text);
  }

  @Test
  public void changedCallerInputCannotChangeDurableAttempt() {
    Memory disk = new Memory();
    CommandJournal journal = new CommandJournal(disk);
    JSONObject body = Json.obj("amountOre", 1000);
    journal.begin("https://pos.example", "a:b", "", "/tabs/t1/payments", "POST", body, "Betala");
    Json.put(body, "amountOre", 5000);
    assertEquals(1000, journal.load().body.optInt("amountOre"));
  }

  @Test
  public void clearingFailurePreservesOriginalAttempt() {
    Memory disk = new Memory();
    CommandJournal j = new CommandJournal(disk);
    j.begin("https://pos.example", "a:b", "", "/tabs", "POST", new JSONObject(), "Ny");
    String key = j.load().body.optString("key");
    disk.available = false;
    assertThrows(IllegalStateException.class, j::clear);
    assertEquals(key, j.load().body.optString("key"));
  }

  @Test
  public void doesNotReplayPhysicalPrintsOrCopiesAutomatically() {
    Memory disk = new Memory();
    CommandJournal j = new CommandJournal(disk);
    assertFalse(
        j.begin(
                "https://pos.example",
                "a:b",
                "",
                "/print-jobs/p/actions",
                "POST",
                Json.obj("action", "reprint"),
                "Kopia")
            .retryable());
  }

  @Test
  public void deviceUpdatesRotateCodesAndCannotBeReplayedLikeOrdinaryPut() {
    Memory disk = new Memory();
    CommandJournal j = new CommandJournal(disk);
    assertFalse(
        j.begin(
                "https://pos.example",
                "a:b",
                "",
                "/devices/main",
                "PUT",
                Json.obj("name", "Kassa"),
                "Ändra enhet")
            .retryable());
  }

  @Test
  public void refusesCorruptAndUnsafeJournalInput() {
    Memory disk = new Memory();
    CommandJournal j = new CommandJournal(disk);
    assertThrows(
        IllegalArgumentException.class,
        () ->
            j.begin(
                "https://pos.example", "a:b", "", "/../logout", "POST", new JSONObject(), "Test"));
    disk.text = "not json";
    assertThrows(IllegalArgumentException.class, j::load);
  }

  @Test
  public void attemptsAreBoundToStaffDeviceServerAndTestRound() {
    Memory disk = new Memory();
    CommandJournal j = new CommandJournal(disk);
    CommandJournal.Pending p =
        j.begin("https://pos.example", "a:b", "r1", "/tabs", "POST", new JSONObject(), "Ny");
    Snapshot correct =
        new Snapshot(
            Json.obj(
                "actor",
                Json.obj("staff", Json.obj("id", "a"), "device", Json.obj("id", "b")),
                "testRoundId",
                "r1"),
            null);
    assertTrue(p.matches("https://pos.example", correct));
    assertFalse(p.matches("https://other.example", correct));
    Json.put(correct.raw, "testRoundId", "r2");
    assertFalse(p.matches("https://pos.example", new Snapshot(correct.raw, null)));
  }
}
