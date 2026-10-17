package se.restaurant.nativepos;

import android.text.InputType;
import android.widget.*;
import java.util.*;
import org.json.*;

public final class AdminForms {
  private final MainActivity a;
  private final Ui ui;
  private static final int
      DECIMAL = InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL,
      NUMBER = InputType.TYPE_CLASS_NUMBER;

  public AdminForms(MainActivity a) {
    this.a = a;
    ui = a.ui;
  }

  private static String text(EditText input) {
    String s = input.getText().toString().trim();
    if (s.isEmpty())
      throw new IllegalArgumentException("Fyll i " + input.getContentDescription() + ".");
    return s;
  }

  private void save(String path, JSONObject body, String label) {
    a.write(path, body, "PUT", label);
  }

  public void appearance() {
    LinearLayout form = ui.column();
    Spinner layout =
        ui.select(
            form,
            "Arbetsyta",
            Arrays.asList("Automatisk", "Handkassa", "Huvudkassa"),
            Ui.index(
                new String[] {"auto", "handheld", "counter"},
                a.controller.preferences.getString("layout", "auto")));
    Spinner accent =
        ui.select(
            form,
            "Accentfärg",
            Arrays.asList("Orange", "Turkos", "Blå", "Grå"),
            Ui.index(
                new String[] {"orange", "teal", "blue", "slate"},
                a.controller.preferences.getString("accent", "orange")));
    CheckBox awake =
        ui.check(form, "Håll skärmen vaken", a.controller.preferences.getBoolean("awake", true));
    a.modal(
        "Utseende",
        form,
        "Spara",
        () -> {
          a.controller
              .preferences
              .edit()
              .putString(
                  "layout", Ui.selected(layout, new String[] {"auto", "handheld", "counter"}))
              .putString(
                  "accent", Ui.selected(accent, new String[] {"orange", "teal", "blue", "slate"}))
              .putBoolean("awake", awake.isChecked())
              .apply();
          a.dismiss();
          a.awake();
          a.rebuild();
        });
  }

  public void create() {
    a.choose(
        "Lägg till",
        new String[] {"Artikel", "Bord", "Personal", "Enhet", "Skrivare"},
        i -> {
          if (i == 0) menu(null);
          if (i == 1) table(null);
          if (i == 2) staff(null);
          if (i == 3) device(null);
          if (i == 4) printer(null);
        });
  }

  public void company() {
    JSONObject settings = Json.copy(a.controller.snapshot.settings),
        company = Json.child(settings, "company");
    LinearLayout form = ui.column();
    EditText name = ui.field(form, "Företagsnamn", company.optString("name")),
        org =
            ui.field(
                form,
                "Organisationsnummer, 10 siffror",
                company.optString("organizationNumber"),
                NUMBER),
        address = ui.field(form, "Adress", company.optString("address")),
        city = ui.field(form, "Postnummer och ort", company.optString("city")),
        phone = ui.field(form, "Telefon", company.optString("phone")),
        register = ui.field(form, "Kassabeteckning", settings.optString("registerId"));
    List<JSONObject> rules = Json.list(settings, "taxRules");
    List<EditText> rates = new ArrayList<>();
    for (JSONObject rule : rules)
      rates.add(
          ui.field(
              form,
              "Moms % · "
                  + rule.optString("taxClass")
                  + " · "
                  + rule.optString("mode")
                  + " från "
                  + rule.optString("from"),
              Money.input(rule.optLong("rateBps")),
              DECIMAL));
    a.modal(
        "Företagsuppgifter",
        form,
        "Spara",
        () -> {
          if (!org.getText().toString().matches("[0-9]{10}"))
            throw new IllegalArgumentException("Organisationsnumret ska ha 10 siffror.");
          Json.put(
              settings,
              "company",
              Json.obj(
                  "name",
                  text(name),
                  "organizationNumber",
                  org.getText().toString(),
                  "address",
                  text(address),
                  "city",
                  text(city),
                  "phone",
                  phone.getText().toString()));
          Json.put(settings, "registerId", text(register));
          JSONArray tax = new JSONArray();
          for (int i = 0; i < rules.size(); i++) {
            JSONObject rule = Json.copy(rules.get(i));
            long bps = Forms.amount(rates.get(i));
            if (bps > 10000) throw new IllegalArgumentException("Moms får vara högst 100 %.");
            Json.put(rule, "rateBps", bps);
            tax.put(rule);
          }
          Json.put(settings, "taxRules", tax);
          save("/settings", settings, "Ändra företagsuppgifter");
        });
  }

  public void menu(JSONObject original) {
    JSONObject item =
        original == null
            ? Json.obj(
                "id",
                UUID.randomUUID().toString(),
                "name",
                "",
                "category",
                "Mat",
                "description",
                "",
                "priceOre",
                0,
                "takeawayPriceOre",
                null,
                "taxClass",
                "food",
                "course",
                "main",
                "station",
                "kitchen",
                "available",
                true,
                "example",
                false,
                "modifiers",
                new JSONArray())
            : Json.copy(original);
    LinearLayout form = ui.column();
    EditText name = ui.field(form, "Artikelnamn", item.optString("name")),
        category = ui.field(form, "Kategori", item.optString("category")),
        description = ui.field(form, "Beskrivning", item.optString("description")),
        price = ui.field(form, "Pris i kronor", Money.input(item.optLong("priceOre")), DECIMAL),
        takeaway =
            ui.field(
                form,
                "Avhämtningspris, tomt = samma",
                item.isNull("takeawayPriceOre")
                    ? ""
                    : Money.input(item.optLong("takeawayPriceOre")),
                DECIMAL);
    String[] taxes = {"food", "alcohol", "standard"},
        courses = {"starter", "main", "dessert", "drink"},
        stations = {"kitchen", "bar"};
    Spinner
        tax =
            ui.select(
                form,
                "Momsklass",
                Arrays.asList("Mat", "Alkohol", "Standard"),
                Ui.index(taxes, item.optString("taxClass"))),
        course =
            ui.select(
                form,
                "Serveras som",
                Arrays.asList("Förrätt", "Varmrätt", "Dessert", "Dryck"),
                Ui.index(courses, item.optString("course"))),
        station =
            ui.select(
                form,
                "Station",
                Arrays.asList("Kök", "Bar"),
                Ui.index(stations, item.optString("station")));
    String[] kinds = {"goods", "services"};
    Spinner
        itemKind =
            ui.select(
                form,
                "Varuslag på plats",
                Arrays.asList("Vara", "Tjänst"),
                Ui.index(kinds, item.optString("itemKind", "services"))),
        takeawayKind =
            ui.select(
                form,
                "Varuslag vid avhämtning",
                Arrays.asList("Vara", "Tjänst"),
                Ui.index(kinds, item.optString("takeawayItemKind", "goods")));
    CheckBox available = ui.check(form, "Tillgänglig", item.optBoolean("available")),
        example = ui.check(form, "Markera som exempelpris", item.optBoolean("example"));
    List<JSONObject> groups = Json.list(item, "modifiers");
    LinearLayout modifierList = ui.column();
    ui.full(form, ui.label("Tillvalsgrupper"));
    ui.full(form, modifierList);
    Runnable render =
        () -> {
          modifierList.removeAllViews();
          for (JSONObject group : new ArrayList<>(groups))
            ui.full(
                modifierList,
                ui.button(
                    group.optString("name") + " · ändra",
                    false,
                    () -> modifier(item, group, groups)));
        };
    render.run();
    ui.full(form, ui.button("Lägg till tillvalsgrupp", false, () -> modifier(item, null, groups)));
    // Persist form fields before opening a nested modifier editor; local changes are not sent yet.
    Runnable collect =
        () -> {
          Json.put(item, "name", text(name));
          Json.put(item, "category", text(category));
          Json.put(item, "description", description.getText().toString());
          Json.put(item, "priceOre", Forms.amount(price));
          Json.put(
              item,
              "takeawayPriceOre",
              takeaway.getText().toString().trim().isEmpty() ? null : Forms.amount(takeaway));
          Json.put(item, "taxClass", Ui.selected(tax, taxes));
          Json.put(item, "course", Ui.selected(course, courses));
          Json.put(item, "station", Ui.selected(station, stations));
          Json.put(item, "available", available.isChecked());
          Json.put(item, "example", example.isChecked());
          Json.put(item, "modifiers", new JSONArray(groups));
        };
    modifierList.removeAllViews();
    for (JSONObject group : new ArrayList<>(groups))
      ui.full(
          modifierList,
          ui.button(
              group.optString("name") + " · ändra",
              false,
              () ->
                  a.safe(
                      () -> {
                        collect.run();
                        modifier(item, group, groups);
                      })));
    ((TextView) form.getChildAt(form.getChildCount() - 1))
        .setOnClickListener(
            v ->
                a.safe(
                    () -> {
                      collect.run();
                      modifier(item, null, groups);
                    }));
    a.modal(
        original == null ? "Ny artikel" : "Ändra artikel",
        form,
        "Spara",
        () -> {
          collect.run();
          Json.put(item, "itemKind", Ui.selected(itemKind, kinds));
          Json.put(item, "takeawayItemKind", Ui.selected(takeawayKind, kinds));
          save("/menu/" + Json.id(item), item, "Spara artikel");
        });
  }

  private void modifier(JSONObject item, JSONObject existing, List<JSONObject> groups) {
    JSONObject group =
        existing == null
            ? Json.obj(
                "id",
                UUID.randomUUID().toString(),
                "name",
                "",
                "min",
                0,
                "max",
                1,
                "options",
                new JSONArray())
            : Json.copy(existing);
    LinearLayout form = ui.column();
    EditText name = ui.field(form, "Gruppnamn", group.optString("name")),
        min = ui.field(form, "Minst antal val", group.optString("min"), NUMBER),
        max = ui.field(form, "Högst antal val", group.optString("max"), NUMBER);
    List<JSONObject> options = Json.list(group, "options");
    List<EditText> names = new ArrayList<>(), prices = new ArrayList<>();
    int count = Math.max(3, Math.min(20, options.size() + 1));
    for (int i = 0; i < count; i++) {
      JSONObject option = i < options.size() ? options.get(i) : new JSONObject();
      names.add(
          ui.field(form, "Alternativ " + (i + 1) + ", tomt = borttaget", option.optString("name")));
      prices.add(
          ui.field(
              form, "Tilläggspris " + (i + 1), Money.input(option.optLong("priceOre")), DECIMAL));
    }
    if (existing != null)
      ui.full(
          form,
          ui.button(
              "Ta bort gruppen",
              false,
              () -> {
                groups.remove(existing);
                Json.put(item, "modifiers", new JSONArray(groups));
                menu(item);
              }));
    a.modal(
        "Tillvalsgrupp",
        form,
        "Till artikeln",
        () -> {
          JSONArray values = new JSONArray();
          for (int i = 0; i < count; i++)
            if (!names.get(i).getText().toString().trim().isEmpty())
              values.put(
                  Json.obj(
                      "id",
                      i < options.size() ? Json.id(options.get(i)) : UUID.randomUUID().toString(),
                      "name",
                      text(names.get(i)),
                      "priceOre",
                      Forms.amount(prices.get(i))));
          int minValue = Forms.integer(min, 0, 20), maxValue = Forms.integer(max, 1, 20);
          if (minValue > maxValue || maxValue > values.length())
            throw new IllegalArgumentException("Kontrollera minsta och högsta antal val.");
          Json.put(group, "name", text(name));
          Json.put(group, "min", minValue);
          Json.put(group, "max", maxValue);
          Json.put(group, "options", values);
          if (existing != null) groups.set(groups.indexOf(existing), group);
          else groups.add(group);
          Json.put(item, "modifiers", new JSONArray(groups));
          menu(item);
        });
  }

  public void table(JSONObject existing) {
    JSONObject t =
        existing == null
            ? Json.obj(
                "id",
                UUID.randomUUID().toString(),
                "name",
                "",
                "seats",
                2,
                "area",
                "Matsal",
                "x",
                10,
                "y",
                10,
                "active",
                true)
            : Json.copy(existing);
    LinearLayout form = ui.column();
    EditText name = ui.field(form, "Bordsnamn", t.optString("name")),
        seats = ui.field(form, "Antal platser", t.optString("seats"), NUMBER),
        area = ui.field(form, "Område", t.optString("area")),
        x = ui.field(form, "Position X, procent", t.optString("x"), NUMBER),
        y = ui.field(form, "Position Y, procent", t.optString("y"), NUMBER);
    CheckBox active = ui.check(form, "Aktivt", t.optBoolean("active"));
    a.modal(
        "Bord",
        form,
        "Spara",
        () -> {
          Json.put(t, "name", text(name));
          Json.put(t, "seats", Forms.integer(seats, 1, 100));
          Json.put(t, "area", text(area));
          Json.put(t, "x", Forms.integer(x, 0, 100));
          Json.put(t, "y", Forms.integer(y, 0, 100));
          Json.put(t, "active", active.isChecked());
          save("/tables/" + Json.id(t), t, "Spara bord");
        });
  }

  public void staff(JSONObject existing) {
    JSONObject s =
        existing == null
            ? Json.obj(
                "id", UUID.randomUUID().toString(), "name", "", "role", "waiter", "active", true)
            : Json.copy(existing);
    LinearLayout form = ui.column();
    EditText name = ui.field(form, "Namn", s.optString("name")),
        pin =
            ui.field(
                form,
                "Ny PIN, tomt = behåll",
                "",
                NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
    String[] roles = {"admin", "cashier", "waiter", "kitchen", "bar"};
    Spinner role =
        ui.select(
            form,
            "Roll",
            Arrays.asList("Ansvarig", "Kassör", "Servering", "Kök", "Bar"),
            Ui.index(roles, s.optString("role")));
    CheckBox active = ui.check(form, "Aktiv", s.optBoolean("active"));
    a.modal(
        "Personal",
        form,
        "Spara",
        () -> {
          Json.put(s, "name", text(name));
          Json.put(s, "role", Ui.selected(role, roles));
          Json.put(s, "active", active.isChecked());
          String value = pin.getText().toString();
          if (!value.isEmpty() && !value.matches("[0-9]{4,8}"))
            throw new IllegalArgumentException("PIN ska innehålla 4–8 siffror.");
          if (existing == null && value.isEmpty())
            throw new IllegalArgumentException("Ange PIN för ny personal.");
          if (!value.isEmpty()) Json.put(s, "pin", value);
          save("/staff/" + Json.id(s), s, "Spara personal");
        });
  }

  public void device(JSONObject existing) {
    JSONObject d = existing == null ? new JSONObject() : existing;
    LinearLayout form = ui.column();
    EditText name = ui.field(form, "Enhetsnamn", d.optString("name"));
    String[] kinds = {"main", "serving", "display"};
    Spinner
        kind =
            ui.select(
                form,
                "Typ",
                Arrays.asList("Huvudkassa", "Handkassa", "Orderskärm"),
                Ui.index(kinds, d.optString("kind"))),
        station =
            ui.select(
                form,
                "Station för orderskärm",
                Arrays.asList("Kök", "Bar"),
                d.optString("station").equals("bar") ? 1 : 0);
    CheckBox active = ui.check(form, "Aktiv", d.optBoolean("active", true));
    a.modal(
        "Enhet",
        form,
        "Spara",
        () -> {
          JSONObject body =
              Json.obj(
                  "name",
                  text(name),
                  "kind",
                  Ui.selected(kind, kinds),
                  "station",
                  kind.getSelectedItemPosition() == 2
                      ? (station.getSelectedItemPosition() == 0 ? "kitchen" : "bar")
                      : null,
                  "active",
                  active.isChecked());
          a.write(
              existing == null ? "/devices" : "/devices/" + Json.id(existing),
              body,
              existing == null ? "POST" : "PUT",
              "Spara enhet");
        });
  }

  public void printer(JSONObject existing) {
    JSONObject p =
        existing == null
            ? Json.obj(
                "id",
                UUID.randomUUID().toString(),
                "name",
                "",
                "destination",
                "guest",
                "paperWidthMm",
                80,
                "active",
                true)
            : Json.copy(existing);
    LinearLayout form = ui.column();
    EditText name = ui.field(form, "Skrivarnamn", p.optString("name"));
    String[] dest = {"guest", "kitchen", "bar"};
    Spinner
        destination =
            ui.select(
                form,
                "Användning",
                Arrays.asList("Gästkvitto", "Kök", "Bar"),
                Ui.index(dest, p.optString("destination"))),
        width =
            ui.select(
                form,
                "Pappersbredd",
                Arrays.asList("58 mm", "80 mm"),
                p.optInt("paperWidthMm") == 58 ? 0 : 1);
    CheckBox active = ui.check(form, "Aktiv", p.optBoolean("active"));
    a.modal(
        "Skrivarprofil",
        form,
        "Spara",
        () -> {
          Json.put(p, "name", text(name));
          Json.put(p, "destination", Ui.selected(destination, dest));
          Json.put(p, "paperWidthMm", width.getSelectedItemPosition() == 0 ? 58 : 80);
          Json.put(p, "active", active.isChecked());
          save("/printers/" + Json.id(p), p, "Spara skrivarprofil");
        });
  }
}
