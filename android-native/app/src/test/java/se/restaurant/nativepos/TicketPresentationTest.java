package se.restaurant.nativepos;

import static org.junit.Assert.*;
import org.json.*;
import org.junit.Test;

public class TicketPresentationTest {
  private JSONObject line(String name, String state) {
    return Json.obj("name", name, "quantity", 2, "status", state, "modifiers",
        new JSONArray().put(Json.obj("name", "Glutenfri pasta")), "notes", "Utan lök");
  }

  @Test public void preservesModifiersNotesAndQuantitiesButExcludesCancelledItems() {
    JSONObject ticket = Json.obj("kind", "order", "status", "queued", "items",
        new JSONArray().put(line("Pasta", "sent")).put(line("Felregistrerad pizza", "void")));
    String text = TicketPresentation.details(ticket);
    assertTrue(text.contains("2 × Pasta"));
    assertTrue(text.contains("+ Glutenfri pasta"));
    assertTrue(text.contains("Obs: Utan lök"));
    assertFalse(text.contains("Felregistrerad"));
    assertTrue(TicketPresentation.active(ticket));
  }

  @Test public void hidesEmptyCancelledOrdersButRetainsTheirCancellationTickets() {
    JSONObject ticket = Json.obj("kind", "order", "status", "queued", "items",
        new JSONArray().put(line("Pasta", "void")));
    assertFalse(TicketPresentation.active(ticket));
    Json.put(ticket, "kind", "cancel");
    Json.put(ticket, "reason", "Feltryck av servitör");
    assertTrue(TicketPresentation.active(ticket));
    assertTrue(TicketPresentation.details(ticket).contains("ANNULLERING"));
    assertTrue(TicketPresentation.details(ticket).contains("Feltryck av servitör"));
    assertTrue(TicketPresentation.details(ticket).contains("2 × Pasta"));
    Json.put(ticket, "status", "served");
    assertFalse(TicketPresentation.active(ticket));
  }

  @Test public void onlyOffersTheNextServerAcceptedState() {
    assertEquals("started", TicketPresentation.nextState("queued"));
    assertEquals("ready", TicketPresentation.nextState("started"));
    assertEquals("served", TicketPresentation.nextState("ready"));
    assertEquals("", TicketPresentation.nextState("served"));
    assertEquals("", TicketPresentation.nextState("unrecognised"));
  }
}
