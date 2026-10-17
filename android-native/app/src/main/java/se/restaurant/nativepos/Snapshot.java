package se.restaurant.nativepos;

import java.util.*;
import org.json.JSONObject;

/** Built on the I/O executor, never inside RecyclerView binding or scrolling. */
public final class Snapshot {
  public final JSONObject raw, actor, day, settings;
  public final List<JSONObject> menu, tables, tabs, payments, tickets, receipts, prints, days;
  public final Map<String, Long> totals = new HashMap<>(), paid = new HashMap<>();
  public final String owner, role, round, deviceKind, deviceStation;
  public final List<Product> products;
  public final List<String> categories;
  public final Set<String> lockedTabs = new HashSet<>();
  private final String menuJson;

  public Snapshot(JSONObject value, Snapshot previous) {
    raw = value;
    actor = Json.child(value, "actor");
    day = value.optJSONObject("currentDay");
    settings = Json.child(value, "settings");
    owner = Json.id(Json.child(actor, "staff")) + ":" + Json.id(Json.child(actor, "device"));
    role = Json.s(Json.child(actor, "staff"), "role");
    round = value.optString("testRoundId", "");
    deviceKind = Json.s(Json.child(actor, "device"), "kind");
    deviceStation = Json.s(Json.child(actor, "device"), "station");
    menu = Collections.unmodifiableList(Json.list(value, "menu"));
    tables = Collections.unmodifiableList(Json.list(value, "tables"));
    tabs = Collections.unmodifiableList(Json.list(value, "tabs"));
    payments = Collections.unmodifiableList(Json.list(value, "payments"));
    tickets = Collections.unmodifiableList(Json.list(value, "tickets"));
    receipts = Collections.unmodifiableList(Json.list(value, "receipts"));
    prints = Collections.unmodifiableList(Json.list(value, "printJobs"));
    days = Collections.unmodifiableList(Json.list(value, "days"));
    for (JSONObject tab : tabs) totals.put(Json.id(tab), Money.total(tab));
    for (JSONObject payment : payments)
      if (payment.optString("kind").equals("sale")) {
        String status = payment.optString("status"), tab = payment.optString("tabId");
        if (status.equals("approved")) paid.merge(tab, payment.optLong("amountOre"), Long::sum);
        if (Arrays.asList("approved", "pending", "unknown").contains(status)) lockedTabs.add(tab);
      }
    menuJson = String.valueOf(value.optJSONArray("menu"));
    if (previous != null && previous.menuJson.equals(menuJson)) {
      products = previous.products;
      categories = previous.categories;
    } else {
      LinkedHashMap<String, Integer> tones = new LinkedHashMap<>();
      List<Product> rows = new ArrayList<>();
      for (JSONObject item : menu) {
        String category = item.optString("category");
        tones.putIfAbsent(category, tones.size() % 6);
        rows.add(new Product(item, tones.get(category)));
      }
      products = Collections.unmodifiableList(rows);
      List<String> names = new ArrayList<>();
      names.add("Alla");
      names.addAll(tones.keySet());
      categories = Collections.unmodifiableList(names);
    }
  }

  public JSONObject tab(String id) {
    return Json.find(tabs, id);
  }

  public long remaining(JSONObject tab) {
    return Math.max(0, totals.getOrDefault(Json.id(tab), 0L) - paid.getOrDefault(Json.id(tab), 0L));
  }

  public boolean manager() {
    return role.equals("admin") || role.equals("cashier");
  }

  public boolean canCash() {
    return manager() && deviceKind.equals("main");
  }

  public boolean stationOnly() {
    return role.equals("kitchen") || role.equals("bar") || deviceKind.equals("display");
  }

  public static final class Product {
    public final JSONObject json;
    public final String id, name, description, category, search, price, takeawayPrice, signature;
    public final boolean available;
    public final int tone;

    Product(JSONObject o, int tone) {
      json = o;
      id = Json.id(o);
      name = o.optString("name");
      description = o.optString("description");
      category = o.optString("category");
      search = (name + " " + description + " " + category).toLowerCase(Locale.ROOT);
      price = Money.format(o.optLong("priceOre"));
      takeawayPrice =
          Money.format(
              o.isNull("takeawayPriceOre") ? o.optLong("priceOre") : o.optLong("takeawayPriceOre"));
      available = o.optBoolean("available");
      this.tone = tone;
      signature = o.toString() + tone;
    }
  }
}
