package se.restaurant.nativepos;

import android.text.InputType;
import android.widget.*;
import java.util.*;
import org.json.*;

/** Native forms. Every money-changing write goes through the durable command journal. */
public final class Forms {
  private final MainActivity a;
  private final Ui ui;

  public Forms(MainActivity activity) {
    a = activity;
    ui = a.ui;
  }

  private Snapshot data() {
    return a.controller.snapshot;
  }

  public static String status(String status) {
    switch (status) {
      case "open":
        return "Öppen";
      case "closed":
        return "Stängd";
      case "paid":
        return "Betald";
      case "approved":
        return "Godkänd";
      case "declined":
        return "Nekad";
      case "cancelled":
        return "Avbruten";
      case "pending":
        return "Pågår";
      case "unknown":
      case "uncertain":
        return "Behöver kontrolleras";
      case "confirmed":
        return "Bekräftad";
      case "printed":
        return "Utskriven";
      case "preview":
        return "Förhandsvisning";
      case "failed":
        return "Misslyckad";
      case "card":
        return "Kort";
      case "cash":
        return "Kontant";
      case "swish":
        return "Swish";
      case "draft":
        return "Ej skickad";
      case "held":
        return "Väntar på utslag";
      case "sent":
        return "Skickad";
      case "queued":
        return "Väntar";
      case "started":
        return "Tillagas";
      case "ready":
        return "Klar";
      case "served":
        return "Serverad";
      case "void":
        return "Makulerad";
      default:
        return status;
    }
  }

  public static String course(String value) {
    switch (value) {
      case "starter":
        return "förrätt";
      case "main":
        return "varmrätt";
      case "dessert":
        return "dessert";
      default:
        return "dryck";
    }
  }

  public static long amount(EditText input) {
    Long value = Money.parse(input.getText().toString());
    if (value == null)
      throw new IllegalArgumentException(
          "Ange ett giltigt belopp i kronor, med högst två decimaler.");
    return value;
  }

  public static int integer(EditText input, int min, int max) {
    try {
      int n = Integer.parseInt(input.getText().toString());
      if (n < min || n > max) throw new NumberFormatException();
      return n;
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException("Ange ett heltal mellan " + min + " och " + max + ".");
    }
  }

  private static String required(EditText input, int min) {
    String value = input.getText().toString().trim();
    if (value.length() < min)
      throw new IllegalArgumentException(
          "Fyll i " + input.getContentDescription() + " (minst " + min + " tecken).");
    return value;
  }

  private static final int NUMBER = InputType.TYPE_CLASS_NUMBER,
      DECIMAL = InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL;

  public void newTab(JSONObject table) {
    if (data().day == null) {
      a.navigate("reports");
      return;
    }
    LinearLayout form = ui.column();
    EditText guests =
        ui.field(form, "Antal gäster", table == null ? "1" : table.optString("seats", "1"), NUMBER);
    Spinner mode = ui.select(form, "Försäljningssätt", Arrays.asList("På plats", "Avhämtning"), 0);
    mode.setEnabled(table == null);
    a.modal(
        table == null ? "Ny disknota" : table.optString("name"),
        form,
        "Öppna nota",
        () ->
            a.write(
                "/tabs",
                Json.obj(
                    "tableId",
                    table == null ? null : Json.id(table),
                    "guestCount",
                    integer(guests, 1, 100),
                    "serviceMode",
                    table == null && mode.getSelectedItemPosition() == 1 ? "takeaway" : "dine_in"),
                "POST",
                "Öppna nota"));
  }

  public void item(Snapshot.Product product, JSONObject originalTab) {
    if (!a.controller.writable()) return;
    LinearLayout form = ui.column();
    ui.full(form, ui.text(product.description, 14, Ui.MUTED, false));
    ui.full(
        form,
        ui.text(
            originalTab.optString("serviceMode").equals("takeaway")
                ? product.takeawayPrice
                : product.price,
            28,
            ui.accent,
            true));
    EditText quantity = ui.field(form, "Antal", "1", NUMBER);
    List<String> guests = new ArrayList<>();
    guests.add("Gemensamt");
    for (int i = 1; i <= originalTab.optInt("guestCount"); i++) guests.add("Gäst " + i);
    Spinner guest = ui.select(form, "Gäst", guests, Math.min(1, guests.size() - 1));
    List<JSONObject> groups = Json.list(product.json, "modifiers");
    Map<String, CheckBox> choices = new LinkedHashMap<>();
    for (JSONObject group : groups) {
      ui.full(
          form,
          ui.label(
              group.optString("name")
                  + " · välj "
                  + group.optInt("min")
                  + "–"
                  + group.optInt("max")));
      for (JSONObject option : Json.list(group, "options"))
        choices.put(
            Json.id(option),
            ui.check(
                form,
                option.optString("name")
                    + (option.optLong("priceOre") > 0
                        ? " +" + Money.format(option.optLong("priceOre"))
                        : ""),
                false));
    }
    String[] courseIds = {"starter", "main", "dessert", "drink"};
    Spinner course =
        ui.select(
            form,
            "Serveras som",
            Arrays.asList("Förrätt", "Varmrätt", "Dessert", "Dryck"),
            Ui.index(courseIds, product.json.optString("course")));
    CheckBox hold =
        ui.check(form, "Håll för senare utslag", product.json.optString("course").equals("main"));
    EditText notes = ui.field(form, "Meddelande till köket", "");
    a.modal(
        product.name,
        form,
        "Lägg till",
        () -> {
          Snapshot.Product current = null;
          for (Snapshot.Product p : data().products) if (p.id.equals(product.id)) current = p;
          if (current == null || !current.signature.equals(product.signature))
            throw new IllegalArgumentException(
                "Artikeln har ändrats. Öppna den igen för att se aktuellt pris och tillval.");
          JSONArray modifiers = new JSONArray();
          for (Map.Entry<String, CheckBox> choice : choices.entrySet())
            if (choice.getValue().isChecked()) modifiers.put(choice.getKey());
          for (JSONObject group : groups) {
            int count = 0;
            for (JSONObject option : Json.list(group, "options"))
              if (choices.get(Json.id(option)).isChecked()) count++;
            if (count < group.optInt("min") || count > group.optInt("max"))
              throw new IllegalArgumentException(
                  "Kontrollera tillval för " + group.optString("name") + ".");
          }
          JSONObject tab = data().tab(Json.id(originalTab));
          a.command(
              tab,
              Json.obj(
                  "action",
                  "add",
                  "itemId",
                  product.id,
                  "quantity",
                  integer(quantity, 1, 100),
                  "guest",
                  guest.getSelectedItemPosition(),
                  "modifiers",
                  modifiers,
                  "notes",
                  notes.getText().toString(),
                  "course",
                  Ui.selected(course, courseIds),
                  "hold",
                  hold.isChecked()),
              "Lägg till " + product.name);
        });
  }

  public void line(JSONObject line, JSONObject tab) {
    if (tab == null || !tab.optString("status").equals("open")) {
      a.textDialog(line.optString("name"), "Notan är avslutad. Rättelser görs som returer.");
      return;
    }
    List<String> actions = new ArrayList<>();
    actions.add("Ta bort artikel");
    if (data().manager()) actions.add("Ändra pris");
    a.choose(
        line.optString("name"),
        actions.toArray(new String[0]),
        index -> {
          LinearLayout form = ui.column();
          EditText reason = ui.field(form, "Orsak", "");
          if (index == 0) removeLine(line, tab, false);
          else {
            EditText price =
                ui.field(
                    form,
                    "Nytt styckpris i kronor",
                    Money.input(line.optLong("unitPriceOre")),
                    DECIMAL);
            a.modal(
                "Ändra pris",
                form,
                "Spara",
                () ->
                    a.command(
                        data().tab(Json.id(tab)),
                        Json.obj(
                            "action",
                            "price",
                            "lineId",
                            Json.id(line),
                            "priceOre",
                            amount(price),
                            "reason",
                            required(reason, 3)),
                        "Ändra artikelpris"));
          }
        });
  }

  public void removeLine(JSONObject original, JSONObject originalTab, boolean one) {
    if (originalTab == null || !a.controller.writable()) return;
    JSONObject tab = data().tab(Json.id(originalTab));
    JSONObject line = tab == null ? null : TableLookup.byId(Json.list(tab, "lines"), Json.id(original));
    if (line == null || line.optString("status").equals("void") || !tab.optString("status").equals("open")) {
      a.toast("Raden har ändrats. Öppna notan igen.");
      return;
    }
    if (data().lockedTabs.contains(Json.id(tab))) {
      a.toast("Betalning har påbörjats. Raden är låst tills betalningen har retts ut.");
      return;
    }
    boolean sent = !line.optString("status").equals("draft") && !line.optString("status").equals("held");
    if (sent && !data().manager()) {
      a.toast("Be ansvarig makulera artikeln eftersom den redan har skickats.");
      return;
    }
    int count = line.optInt("quantity");
    boolean decrement = one && count > 1;
    if (decrement && !a.controller.quantitySupported) {
      a.textDialog("Uppdatera Android-kassaservern", "Servern saknar stöd för att minska antal. Starta serverdelen i android-native. Ingen artikel har ändrats.");
      return;
    }
    LinearLayout form = ui.column();
    String description = decrement ? count + " → " + (count - 1) + " × " + line.optString("name")
        : "Hela raden tas bort: " + count + " × " + line.optString("name");
    ui.full(form, ui.text(description, 19, Ui.INK, true));
    if (sent) ui.full(form, ui.label("En makuleringsbong skickas till kök eller bar för det borttagna antalet."));
    EditText reason = ui.field(form, "Orsak", "");
    Runnable submit = () -> {
      JSONObject latest = data().tab(Json.id(tab));
      if (latest == null || latest.optInt("version") != tab.optInt("version"))
        throw new IllegalArgumentException("Notan har ändrats. Stäng dialogen och kontrollera raden igen.");
      String why = required(reason, 3);
      if (decrement) a.write("/native/tabs/" + Json.id(tab) + "/decrement",
          Json.obj("version", tab.optInt("version"), "lineId", Json.id(line), "expectedQuantity", count, "reason", why), "POST", "Minska antal " + line.optString("name"));
      else a.command(tab, Json.obj("action", "remove", "lineId", Json.id(line), "reason", why), "Ta bort " + line.optString("name"));
    };
    a.modal(decrement ? "Minska antal" : "Ta bort artikel", form, decrement ? "Minska med 1" : "Ta bort", submit);
  }

  public void tabOptions(JSONObject tab) {
    if (!tab.optString("status").equals("open")) return;
    List<String> choices = new ArrayList<>(Arrays.asList("Ändra antal gäster", "Flytta nota"));
    if (data().manager()) choices.add("Rabatt");
    choices.add("Avsluta tom nota");
    a.choose(
        tab.optString("label"),
        choices.toArray(new String[0]),
        i -> {
          String choice = choices.get(i);
          LinearLayout form = ui.column();
          if (choice.equals("Ändra antal gäster")) {
            EditText n = ui.field(form, "Antal gäster", tab.optString("guestCount"), NUMBER);
            a.modal(
                choice,
                form,
                "Spara",
                () ->
                    a.command(
                        data().tab(Json.id(tab)),
                        Json.obj("action", "guests", "guestCount", integer(n, 1, 100)),
                        choice));
          } else if (choice.equals("Flytta nota")) {
            List<String> labels = new ArrayList<>(), ids = new ArrayList<>();
            labels.add("Disk / avhämtning");
            ids.add("");
            for (JSONObject t : data().tables)
              if (t.optBoolean("active")) {
                labels.add(t.optString("name"));
                ids.add(Json.id(t));
              }
            Spinner selected = ui.select(form, "Flytta till", labels, 0);
            a.modal(
                choice,
                form,
                "Flytta",
                () ->
                    a.command(
                        data().tab(Json.id(tab)),
                        Json.obj(
                            "action",
                            "move",
                            "tableId",
                            ids.get(selected.getSelectedItemPosition()).isEmpty()
                                ? null
                                : ids.get(selected.getSelectedItemPosition())),
                        choice));
          } else if (choice.equals("Rabatt")) {
            EditText percent =
                ui.field(
                    form, "Rabatt i procent", Money.input(tab.optLong("discountBps")), DECIMAL);
            EditText reason = ui.field(form, "Orsak", tab.optString("discountReason"));
            a.modal(
                choice,
                form,
                "Spara",
                () -> {
                  long bps = amount(percent);
                  if (bps > 10000)
                    throw new IllegalArgumentException("Rabatten får vara högst 100 %.");
                  a.command(
                      data().tab(Json.id(tab)),
                      Json.obj(
                          "action", "discount", "discountBps", bps, "reason", required(reason, 3)),
                      choice);
                });
          } else
            a.confirm(
                choice,
                "Notan kan bara avslutas om den är tom.",
                () -> a.command(data().tab(Json.id(tab)), Json.obj("action", "void"), choice));
        });
  }

  public void payment(JSONObject tab) {
    payment(tab, 0);
  }

  public void payment(JSONObject tab, int initialSplit) {
    a.controller.setScope("full");
    for (JSONObject p : data().payments)
      if (p.optString("tabId").equals(Json.id(tab))
          && p.optString("kind").equals("sale")
          && (p.optString("status").equals("unknown") || p.optString("status").equals("pending"))) {
        paymentResult(p);
        return;
      }
    LinearLayout form = ui.column();
    long remaining = data().remaining(tab);
    ui.full(form, ui.text("Återstår " + Money.format(remaining), 28, ui.accent, true));
    ui.full(form, ui.label("Träningsbetalning — inga pengar dras."));
    Spinner split =
        ui.select(
            form,
            "Betala",
            Arrays.asList(
                "Hela notan",
                "Delbelopp",
                "Dela lika",
                "Per gäst",
                "Valda artikelrader",
                "Antal per artikel"),
            initialSplit);
    EditText amount = ui.field(form, "Delbelopp i kronor", Money.input(remaining), DECIMAL);
    EditText parts = ui.field(form, "Antal delar som återstår", "2", NUMBER);
    List<String> guests = new ArrayList<>();
    guests.add("Gemensamt");
    for (int i = 1; i <= tab.optInt("guestCount"); i++) guests.add("Gäst " + i);
    Spinner guest = ui.select(form, "Gäst", guests, 0);
    List<JSONObject> selectable = new ArrayList<>();
    for (JSONObject line : Json.list(tab, "lines"))
      if (!line.optString("status").equals("void")) selectable.add(line);
    ArticleSelection itemList = new ArticleSelection(ui, selectable);
    ui.full(form, itemList);
    Spinner method =
        ui.select(
            form,
            "Betalsätt",
            data().canCash()
                ? Arrays.asList("Kort", "Swish", "Kontanter")
                : Arrays.asList("Kort", "Swish"),
            0);
    EditText tip = ui.field(form, "Dricks i kronor", "0", DECIMAL),
        tendered = ui.field(form, "Mottaget kontant i kronor", Money.input(remaining), DECIMAL);
    CheckBox verified =
        ui.check(form, "Swish-testbetalningen är verifierad på företagets konto", false);
    Spinner simulation =
        ui.select(
            form,
            "Testresultat",
            Arrays.asList("Godkänd", "Nekad", "Avbruten", "Förlorat svar"),
            0);
    CheckBox fiscal = ui.check(form, "Testa förlorat svar från kontrollösningen", false);
    android.widget.AdapterView.OnItemSelectedListener adapt =
        new android.widget.AdapterView.OnItemSelectedListener() {
          public void onItemSelected(
              android.widget.AdapterView<?> p, android.view.View v, int n, long id) {
            ui.showField(amount, split.getSelectedItemPosition() == 1);
            ui.showField(parts, split.getSelectedItemPosition() == 2);
            ui.showField(guest, split.getSelectedItemPosition() == 3);
            itemList.setVisibility(
                split.getSelectedItemPosition() >= 4
                    ? android.view.View.VISIBLE
                    : android.view.View.GONE);
            itemList.mode(split.getSelectedItemPosition() == 5);
            ui.showField(tendered, method.getSelectedItemPosition() == 2);
            verified.setVisibility(
                method.getSelectedItemPosition() == 1
                    ? android.view.View.VISIBLE
                    : android.view.View.GONE);
          }

          public void onNothingSelected(android.widget.AdapterView<?> p) {}
        };
    split.setOnItemSelectedListener(adapt);
    method.setOnItemSelectedListener(adapt);
    a.modal(
        "Ta betalt · " + tab.optString("label"),
        form,
        "Simulera betalning",
        () -> {
          JSONObject current = data().tab(Json.id(tab));
          if (current == null || current.optInt("version") != tab.optInt("version"))
            throw new IllegalArgumentException(
                "Notan har ändrats. Öppna betalningen igen och kontrollera beloppet.");
          String paymentMethod = Ui.selected(method, new String[] {"card", "swish", "cash"});
          long tipOre = amount(tip);
          if (paymentMethod.equals("swish") && !verified.isChecked())
            throw new IllegalArgumentException("Verifiera Swish-testbetalningen först.");
          JSONObject body =
              Json.obj(
                  "version",
                  tab.optInt("version"),
                  "method",
                  paymentMethod,
                  "tipOre",
                  tipOre,
                  "swishVerified",
                  verified.isChecked(),
                  "simulation",
                  Ui.selected(
                      simulation, new String[] {"approved", "declined", "cancelled", "unknown"}),
                  "fiscalSimulation",
                  fiscal.isChecked() ? "unknown" : "confirmed");
          int mode = split.getSelectedItemPosition();
          Long value =
              mode == 0
                  ? remaining
                  : mode == 1
                      ? amount(amount)
                      : mode == 2
                          ? (remaining + integer(parts, 1, 100) - 1) / integer(parts, 1, 100)
                          : null;
          if (value != null) {
            if (value > remaining)
              throw new IllegalArgumentException("Beloppet är större än det som återstår.");
            Json.put(body, "amountOre", value);
          }
          if (mode == 3) Json.put(body, "guest", guest.getSelectedItemPosition());
          if (mode == 4) Json.put(body, "lineIds", itemList.ids());
          if (mode == 5) Json.put(body, "items", itemList.items());
          if (paymentMethod.equals("cash")) Json.put(body, "tenderedOre", amount(tendered));
          a.write(
              "/tabs/" + Json.id(tab) + "/payments",
              body,
              "POST",
              "Betalning på " + tab.optString("label"));
        });
  }

  public void paymentResult(JSONObject payment) {
    a.controller.setScope("full");
    LinearLayout form = ui.column();
    String state = payment.optString("status");
    ui.full(
        form,
        ui.text(
            Money.format(payment.optLong("amountOre") + payment.optLong("tipOre")),
            32,
            state.equals("approved") ? Ui.GREEN : Ui.WARNING,
            true));
    String title =
        state.equals("approved")
            ? "Betalningen är godkänd"
            : state.equals("declined")
                ? "Betalningen nekades"
                : state.equals("cancelled")
                    ? "Betalningen avbröts"
                    : "Betalningen behöver kontrolleras";
    ui.full(form, ui.label("TEST — inga riktiga betalningar"));
    if (state.equals("unknown") || state.equals("pending")) {
      ui.full(
          form, ui.label("Starta inte en ny betalning innan detta försök har ett säkert utfall."));
      ui.full(
          form,
          ui.button(
              "Kontrollera samma betalning",
              true,
              () ->
                  a.write(
                      "/payments/" + Json.id(payment) + "/check",
                      new JSONObject(),
                      "POST",
                      "Kontrollera betalning")));
      ui.gap(form, 8);
      ui.full(
          form,
          ui.button(
              "Avbryt betalningsförsöket",
              false,
              () ->
                  a.write(
                      "/payments/" + Json.id(payment) + "/cancel",
                      new JSONObject(),
                      "POST",
                      "Avbryt betalning")));
    } else if (state.equals("approved"))
      ui.full(
          form, ui.button("Visa testkvitto", false, () -> showReceiptForPayment(Json.id(payment))));
    a.modal(title, form, null, () -> {});
  }

  private void showReceiptForPayment(String id) {
    a.controller.read(
        "/bootstrap?scope=full",
        text -> {
          JSONObject raw = Json.object(text);
          JSONObject receipt = null;
          for (JSONObject r : Json.list(raw, "receipts"))
            if (r.optString("paymentId").equals(id)) receipt = r;
          if (receipt == null) {
            a.toast("Kvittot har inte kommit ännu. Kontrollera betalningens status.");
            return;
          }
          receipt(receipt, Json.list(raw, "printJobs"));
        });
  }

  public void receipt(JSONObject receipt, List<JSONObject> jobs) {
    if (!receipt.optString("fiscalStatus").equals("confirmed")) {
      a.confirm(
          "Kontrollkod saknas",
          "Kontrollera samma kvitto innan det används eller dagen avslutas.",
          () ->
              a.write(
                  "/receipts/" + Json.id(receipt) + "/verify",
                  new JSONObject(),
                  "POST",
                  "Kontrollera kvitto"));
      return;
    }
    for (JSONObject job : jobs)
      if (job.optString("sourceId").equals(Json.id(receipt)) && job.isNull("reprintOf")) {
        LinearLayout form = ui.column();
        TextView paper = ui.text(job.optString("text"), 13, 0xff222222, false);
        paper.setTypeface(android.graphics.Typeface.MONOSPACE);
        paper.setBackgroundColor(0xfffafafa);
        ui.pad(paper, 16);
        paper.setTextIsSelectable(true);
        ui.full(form, paper);
        ui.gap(form, 10);
        ui.full(form, ui.button("Hantera utskrift", false, () -> print(job)));
        a.modal("Övningskvitto #" + receipt.optInt("number"), form, null, () -> {});
        return;
      }
    a.toast("Kvittounderlaget saknas i utskriftskön. Uppdatera Dagsöversikt.");
  }

  public void refund(JSONObject payment) {
    LinearLayout form = ui.column();
    ui.full(form, ui.label("Retur av betalning " + Money.format(payment.optLong("amountOre"))));
    long reserved = 0;
    for (JSONObject p : data().payments)
      if (p.optString("parentId").equals(Json.id(payment))
          && Arrays.asList("approved", "unknown", "pending").contains(p.optString("status")))
        reserved += p.optLong("amountOre");
    Spinner mode =
        ui.select(
            form,
            "Returnera",
            Arrays.asList("Belopp", "Valda artikelrader", "Antal per artikel"),
            0);
    EditText amount =
        ui.field(
            form,
            "Belopp i kronor",
            Money.input(Math.max(0, payment.optLong("amountOre") - reserved)),
            DECIMAL);
    List<JSONObject> rows = new ArrayList<>();
    JSONObject tab = data().tab(payment.optString("tabId"));
    for (JSONObject allocation : Json.list(payment, "allocations")) {
      JSONObject line =
          tab == null ? null : Json.find(Json.list(tab, "lines"), allocation.optString("lineId"));
      rows.add(
          line == null
              ? Json.obj(
                  "id",
                  allocation.optString("lineId"),
                  "name",
                  "Artikel på originalkvittot",
                  "quantity",
                  1)
              : line);
    }
    ArticleSelection selection = new ArticleSelection(ui, rows);
    ui.full(form, selection);
    mode.setOnItemSelectedListener(
        new AdapterView.OnItemSelectedListener() {
          public void onItemSelected(AdapterView<?> p, android.view.View v, int n, long id) {
            ui.showField(amount, n == 0);
            selection.setVisibility(n == 0 ? android.view.View.GONE : android.view.View.VISIBLE);
            selection.mode(n == 2);
          }

          public void onNothingSelected(AdapterView<?> p) {}
        });
    EditText reason = ui.field(form, "Orsak", "");
    Spinner scenario =
        ui.select(
            form,
            "Testresultat",
            Arrays.asList("Godkänd", "Nekad", "Avbruten", "Förlorat svar"),
            0);
    a.modal(
        "Gör retur",
        form,
        "Simulera retur",
        () -> {
          JSONObject body =
              Json.obj(
                  "reason",
                  required(reason, 3),
                  "simulation",
                  Ui.selected(
                      scenario, new String[] {"approved", "declined", "cancelled", "unknown"}),
                  "fiscalSimulation",
                  "confirmed");
          int selected = mode.getSelectedItemPosition();
          if (selected == 0) Json.put(body, "amountOre", amount(amount));
          else if (selected == 1) Json.put(body, "lineIds", selection.ids());
          else Json.put(body, "items", selection.items());
          a.write("/payments/" + Json.id(payment) + "/refunds", body, "POST", "Retur av betalning");
        });
  }

  public void openDay() {
    LinearLayout form = ui.column();
    EditText amount = ui.field(form, "Växelkassa i kronor", "0", DECIMAL);
    a.modal(
        "Öppna dagen",
        form,
        "Öppna dagen",
        () ->
            a.write(
                "/business-days",
                Json.obj("floatOre", amount(amount)),
                "POST",
                "Öppna verksamhetsdag"));
  }

  public void closeDay() {
    JSONObject day = data().day;
    if (day == null) return;
    LinearLayout form = ui.column();
    ui.full(form, ui.label("Kontrollera att notor och osäkra betalningar är hanterade."));
    EditText counted = ui.field(form, "Räknat kontant i kronor", "0", DECIMAL);
    a.modal(
        "Dagsavslut",
        form,
        "Stäng dagen",
        () ->
            a.write(
                "/business-days/" + Json.id(day) + "/close",
                Json.obj("countedCashOre", amount(counted)),
                "POST",
                "Stäng verksamhetsdag"));
  }

  public void cash() {
    if (data().day == null) return;
    LinearLayout form = ui.column();
    Spinner direction = ui.select(form, "Rörelse", Arrays.asList("Insättning", "Uttag"), 0);
    EditText amount = ui.field(form, "Belopp i kronor", "", DECIMAL),
        reason = ui.field(form, "Orsak", "");
    String day = Json.id(data().day);
    a.modal(
        "Kontantrörelse",
        form,
        "Registrera",
        () ->
            a.write(
                "/cash-movements",
                Json.obj(
                    "dayId",
                    day,
                    "direction",
                    direction.getSelectedItemPosition() == 0 ? "in" : "out",
                    "amountOre",
                    amount(amount),
                    "reason",
                    required(reason, 3)),
                "POST",
                "Kontantrörelse"));
  }

  public void print(JSONObject job) {
    String[] labels = {
      "Visa underlag",
      "Skriv ut / förhandsvisa",
      "Bekräfta utskriven",
      "Markera misslyckad",
      "Skriv ut kopia",
      "Välj skrivare"
    };
    a.choose(
        "Utskrift · " + job.optString("status"),
        labels,
        index -> {
          String path = "/print-jobs/" + Json.id(job) + "/actions";
          if (index == 0) {
            a.textDialog("Utskriftsunderlag", job.optString("text"));
            return;
          }
          if (index == 1) {
            a.write(path, Json.obj("action", "print"), "POST", "Utskrift");
            return;
          }
          if (index == 2 || index == 3) {
            a.confirm(
                labels[index],
                "Kontrollera det faktiska utfallet först.",
                () ->
                    a.write(
                        path,
                        Json.obj("action", "resolve", "outcome", index == 2 ? "printed" : "failed"),
                        "POST",
                        "Bekräfta utskriftsutfall"));
            return;
          }
          if (index == 4) {
            LinearLayout form = ui.column();
            EditText reason = ui.field(form, "Orsak till kopia", "");
            a.modal(
                "Skriv ut kopia",
                form,
                "Skapa kopia",
                () ->
                    a.write(
                        path,
                        Json.obj("action", "reprint", "reason", required(reason, 3)),
                        "POST",
                        "Kvittokopia"));
            return;
          }
          List<JSONObject> printers = Json.list(data().raw, "printers");
          List<String> names = new ArrayList<>();
          for (JSONObject p : printers) names.add(p.optString("name"));
          a.choose(
              "Skrivare",
              names.toArray(new String[0]),
              i ->
                  a.write(
                      path,
                      Json.obj("action", "route", "printerId", Json.id(printers.get(i))),
                      "POST",
                      "Byt skrivare"));
        });
  }

  public void ticket(JSONObject ticket) {
    JSONObject current = TableLookup.byId(data().tickets, Json.id(ticket));
    if (current == null || !TicketPresentation.active(current)) {
      a.toast("Bongen är avslutad eller helt makulerad. Uppdatera listan.");
      return;
    }
    LinearLayout form = ui.column();
    ui.full(form, ui.text(TicketPresentation.details(current), 17, Ui.INK, false));
    String state = TicketPresentation.nextState(current.optString("status"));
    if (!state.isEmpty()) {
      boolean cancellation = current.optString("kind").equals("cancel");
      String label = cancellation
          ? (state.equals("started") ? "Påbörja annullering" : state.equals("ready") ? "Annullering hanterad" : "Arkivera annullering")
          : status(state);
      ui.full(
          form,
          ui.button(
              label,
              state.equals("ready"),
              () -> {
                  JSONObject latest = TableLookup.byId(data().tickets, Json.id(current));
                  if (latest == null || !TicketPresentation.active(latest)
                      || !latest.optString("status").equals(current.optString("status"))
                      || !latest.toString().equals(current.toString()))
                    throw new IllegalArgumentException("Bongen har ändrats. Öppna den igen innan du fortsätter.");
                  a.write(
                      "/tickets/" + Json.id(current) + "/status",
                      Json.obj("status", state),
                      "POST",
                      "Ändra bongstatus");
              }));
    }
    a.modal(current.optString("tabLabel") + (current.optString("kind").equals("cancel") ? " · ANNULLERING" : ""), form, null, () -> {});
  }
}
