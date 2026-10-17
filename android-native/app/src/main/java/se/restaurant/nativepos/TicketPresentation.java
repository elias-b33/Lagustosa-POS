package se.restaurant.nativepos;

import org.json.JSONObject;

/** The same preparation details and state progression in the list and the open ticket. */
public final class TicketPresentation {
  private TicketPresentation() {}

  public static boolean active(JSONObject ticket) {
    if (ticket.optString("status").equals("served")) return false;
    for (JSONObject item : Json.list(ticket, "items"))
      if (visibleItem(ticket, item)) return true;
    return false;
  }

  private static boolean visibleItem(JSONObject ticket, JSONObject item) {
    return ticket.optString("kind").equals("cancel") || !item.optString("status").equals("void");
  }

  public static String details(JSONObject ticket) {
    StringBuilder text = new StringBuilder();
    if (ticket.optString("kind").equals("cancel")) {
      text.append("ANNULLERING\n");
      if (!ticket.optString("reason").isEmpty())
        text.append("Orsak: ").append(ticket.optString("reason")).append("\n\n");
    }
    for (JSONObject item : Json.list(ticket, "items")) {
      if (!visibleItem(ticket, item)) continue;
      if (text.length() > 0 && text.charAt(text.length() - 1) != '\n') text.append('\n');
      text.append(item.optInt("quantity")).append(" × ").append(item.optString("name")).append('\n');
      for (JSONObject modifier : Json.list(item, "modifiers"))
        text.append("  + ").append(modifier.optString("name")).append('\n');
      if (!item.optString("notes").trim().isEmpty())
        text.append("Obs: ").append(item.optString("notes")).append('\n');
    }
    return text.toString().trim();
  }

  public static String nextState(String current) {
    switch (current) {
      case "queued": return "started";
      case "started": return "ready";
      case "ready": return "served";
      default: return "";
    }
  }
}
