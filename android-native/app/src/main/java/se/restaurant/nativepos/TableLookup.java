package se.restaurant.nativepos;

import java.util.*;
import java.util.regex.*;
import org.json.JSONObject;

/** Table numbers come from configured names, never from guessed database identifiers. */
public final class TableLookup {
  private static final Pattern NUMBER = Pattern.compile("^(?:bord\\s*)?0*(\\d{1,6})$", Pattern.CASE_INSENSITIVE);

  public static String number(String name) {
    Matcher match = NUMBER.matcher(name.trim());
    return match.matches() ? String.valueOf(Integer.parseInt(match.group(1))) : "";
  }

  public static List<JSONObject> matching(List<JSONObject> tables, String input) {
    String number = number(input);
    List<JSONObject> matches = new ArrayList<>();
    if (number.isEmpty()) return matches;
    for (JSONObject table : tables)
      if (table.optBoolean("active") && number.equals(number(table.optString("name")))) matches.add(table);
    return matches;
  }

  public static JSONObject byId(List<JSONObject> rows, String id) {
    for (JSONObject row : rows) if (id.equals(Json.id(row))) return row;
    return null;
  }

  public static JSONObject openTab(List<JSONObject> tabs, String tableId) {
    for (JSONObject tab : tabs)
      if (tab.optString("status").equals("open") && tableId.equals(tab.optString("tableId"))) return tab;
    return null;
  }
}
