package se.restaurant.nativepos;

import android.view.*;
import android.widget.*;
import androidx.recyclerview.widget.*;
import java.util.*;
import org.json.JSONObject;

public final class WorkspaceScreen implements MainActivity.Screen {
  private final MainActivity a;
  private final Ui ui;
  private final String view;
  private final LinearLayout root, tools;
  private final TextView summary;
  private final RowsAdapter adapter;
  private final AdminForms admin;
  private String reportSection = "Notor";

  private static final class Entry {
    final String kind;
    final JSONObject value;

    Entry(String kind, JSONObject value) {
      this.kind = kind;
      this.value = value;
    }
  }

  public WorkspaceScreen(MainActivity a, String view) {
    this.a = a;
    this.view = view;
    ui = a.ui;
    admin = new AdminForms(a);
    root = ui.column();
    ui.pad(root, 12);
    ui.full(root, ui.text(MainActivity.title(view), 26, Ui.INK, true));
    summary = ui.label("");
    ui.full(root, summary);
    tools = ui.row();
    HorizontalScrollView scroll = new HorizontalScrollView(a);
    scroll.setHorizontalScrollBarEnabled(false);
    scroll.addView(tools);
    root.addView(scroll, ui.lp(-1, 56));
    if (view.equals("reports")) {
      action("Öppna dagen", a.forms::openDay);
      action("Dagsavslut", a.forms::closeDay);
      action("Kontantrörelse", a.forms::cash);
      action("Exportera", this::export);
      action(
          "Säkerhetskopia", () -> a.write("/backups", new JSONObject(), "POST", "Säkerhetskopia"));
      Spinner section =
          ui.select(
              root,
              "Visa",
              Arrays.asList(
                  "Notor", "Betalningar", "Kvitton", "Dagar", "Kassarapporter", "Journal"),
              0);
      section.setOnItemSelectedListener(
          new AdapterView.OnItemSelectedListener() {
            public void onItemSelected(AdapterView<?> p, View v, int i, long id) {
              reportSection = (String) section.getSelectedItem();
              bind(a.controller.snapshot);
            }

            public void onNothingSelected(AdapterView<?> p) {}
          });
    } else if (view.equals("settings")) {
      action("Utseende", admin::appearance);
      action("Företaget", admin::company);
      action("Lägg till", admin::create);
    } else if (view.equals("tables")) action("Ny disknota", () -> a.forms.newTab(null));
    else action("Uppdatera", a.controller::refresh);
    adapter = new RowsAdapter(ui, this::select);
    RecyclerView list = RowsAdapter.list(ui, adapter);
    list.setContentDescription(MainActivity.title(view));
    ui.weight(root, list);
  }

  private void action(String title, Runnable command) {
    TextView b = ui.button(title, false, () -> a.safe(command));
    LinearLayout.LayoutParams p = ui.lp(-2, 48);
    p.rightMargin = ui.dp(6);
    tools.addView(b, p);
  }

  public View view() {
    return root;
  }

  public void bind(Snapshot data) {
    if (data == null) return;
    List<RowsAdapter.Row> rows = new ArrayList<>();
    summary.setText(
        data.day == null
            ? "Ingen verksamhetsdag är öppen"
            : "Verksamhetsdag " + data.day.optString("date"));
    if (view.equals("tables")) {
      Map<String, JSONObject> occupied = new HashMap<>();
      for (JSONObject tab : data.tabs)
        if (tab.optString("status").equals("open") && !tab.isNull("tableId"))
          occupied.put(tab.optString("tableId"), tab);
      for (JSONObject table : data.tables)
        if (table.optBoolean("active")) {
          JSONObject tab = occupied.get(Json.id(table));
          rows.add(
              row(
                  "table",
                  table,
                  table.optString("name"),
                  table.optString("area")
                      + " · "
                      + (tab == null ? table.optInt("seats") : tab.optInt("guestCount"))
                      + " gäster",
                  tab == null ? "Ledigt" : Money.format(data.remaining(tab)),
                  tab == null ? Ui.GREEN : ui.accent));
        }
      for (JSONObject tab : data.tabs)
        if (tab.optString("status").equals("open") && tab.isNull("tableId"))
          rows.add(
              row(
                  "tab",
                  tab,
                  tab.optString("label"),
                  "Disk och avhämtning",
                  Money.format(data.remaining(tab)),
                  ui.accent));
    } else if (view.equals("kitchen") || view.equals("bar")) {
      for (JSONObject ticket : data.tickets)
        if (ticket.optString("station").equals(view)
            && TicketPresentation.active(ticket)) {
          rows.add(
              row(
                  "ticket",
                  ticket,
                  ticket.optString("tabLabel")
                      + (ticket.optString("kind").equals("cancel") ? " · ANNULLERING" : ""),
                  TicketPresentation.details(ticket),
                  Forms.status(ticket.optString("status")),
                  ticket.optString("kind").equals("cancel") ? Ui.DANGER : Ui.GREEN));
        }
      summary.setText(rows.size() + " aktiva bongar");
    } else if (view.equals("prints")) {
      for (JSONObject job : data.prints)
        rows.add(
            row(
                "print",
                job,
                (job.optString("kind").equals("guest")
                    ? "Gästkvitto"
                    : job.optString("kind").equals("closing") ? "Dagsrapport" : "Bong"),
                job.optString("printerName", "Förhandsvisning")
                    + " · "
                    + job.optString("createdAt"),
                Forms.status(job.optString("status")),
                job.optString("status").equals("uncertain") ? Ui.DANGER : Ui.MUTED));
    } else if (view.equals("reports")) {
      JSONObject report = Json.child(data.raw, "report");
      summary.setText(
          "Netto "
              + Money.format(report.optLong("netOre"))
              + " · Kontant "
              + Money.format(report.optLong("expectedCashOre"))
              + "\n"
              + (data.day == null ? "Dagen är stängd" : "Öppen dag " + data.day.optString("date")));
      if (reportSection.equals("Notor"))
        for (JSONObject tab : data.tabs)
          rows.add(
              row(
                  "tab",
                  tab,
                  tab.optString("label"),
                  Forms.status(tab.optString("status")) + " · " + tab.optInt("guestCount") + " gäster",
                  Money.format(data.totals.getOrDefault(Json.id(tab), 0L)),
                  ui.accent));
      if (reportSection.equals("Betalningar"))
        for (JSONObject payment : data.payments)
          rows.add(
              row(
                  "payment",
                  payment,
                  (payment.optString("kind").equals("refund") ? "Retur" : "Betalning")
                      + " · "
                      + Forms.status(payment.optString("method")),
                  payment.optString("createdAt") + " · " + Forms.status(payment.optString("status")),
                  Money.format(payment.optLong("amountOre")),
                  payment.optString("status").equals("approved") ? Ui.GREEN : Ui.WARNING));
      if (reportSection.equals("Kvitton"))
        for (JSONObject receipt : data.receipts)
          rows.add(
              row(
                  "receipt",
                  receipt,
                  "Övningskvitto #" + receipt.optInt("number"),
                  Json.child(receipt, "tab").optString("label")
                      + " · "
                      + Forms.status(receipt.optString("fiscalStatus")),
                  Money.format(Json.child(receipt, "payment").optLong("amountOre")),
                  Ui.INK));
      if (reportSection.equals("Dagar"))
        for (JSONObject day : data.days)
          rows.add(
              row(
                  "day",
                  day,
                  day.optString("date"),
                  Forms.status(day.optString("status")),
                  "Visa rapport",
                  ui.accent));
      if (reportSection.equals("Kassarapporter"))
        for (JSONObject register : Json.list(report, "registers"))
          rows.add(
              row(
                  "register",
                  register,
                  register.optString("registerId"),
                  register.optString("kind") + " · " + register.optString("generatedAt"),
                  "Visa",
                  ui.accent));
      if (reportSection.equals("Journal"))
        rows.add(
            new RowsAdapter.Row(
                "journal",
                "Kontrollera journal",
                "Visa integritet och senaste händelser",
                "Öppna",
                ui.accent,
                new Entry("journal", new JSONObject())));
      if (data.raw.optJSONObject("backup") != null
          && !Json.child(data.raw, "backup").isNull("error"))
        rows.add(
            new RowsAdapter.Row(
                "backup-error",
                "Säkerhetskopian behöver kontrolleras",
                Json.child(data.raw, "backup").optString("error"),
                "",
                Ui.DANGER,
                new Entry("backup", new JSONObject())));
    } else {
      rows.add(
          new RowsAdapter.Row(
              "company",
              Json.child(data.settings, "company").optString("name", "Restaurangkassa"),
              "Företagsuppgifter och moms",
              "Ändra",
              ui.accent,
              new Entry("company", data.settings)));
      for (JSONObject item : data.menu)
        rows.add(
            row(
                "menu",
                item,
                item.optString("name"),
                "Meny · "
                    + item.optString("category")
                    + (item.optBoolean("available") ? "" : " · Ej tillgänglig"),
                Money.format(item.optLong("priceOre")),
                Ui.INK));
      for (JSONObject table : data.tables)
        rows.add(
            row(
                "editTable",
                table,
                table.optString("name"),
                "Bord · " + table.optString("area"),
                "Ändra",
                ui.accent));
      for (JSONObject staff : Json.list(data.raw, "staff"))
        rows.add(
            row(
                "staff",
                staff,
                staff.optString("name"),
                "Personal · " + staff.optString("role"),
                "Ändra",
                ui.accent));
      for (JSONObject device : Json.list(data.raw, "devices"))
        rows.add(
            row(
                "device",
                device,
                device.optString("name"),
                "Enhet · " + device.optString("kind"),
                "Ändra",
                ui.accent));
      for (JSONObject printer : Json.list(data.raw, "printers"))
        rows.add(
            row(
                "printer",
                printer,
                printer.optString("name"),
                "Skrivare · " + printer.optString("destination"),
                "Ändra",
                ui.accent));
    }
    if (rows.isEmpty())
      rows.add(
          new RowsAdapter.Row(
              "empty",
              "Inget att visa ännu",
              "Uppgifterna visas här när de finns.",
              "",
              Ui.MUTED,
              null));
    adapter.submitList(rows);
  }

  private RowsAdapter.Row row(
      String type, JSONObject o, String title, String detail, String value, int color) {
    String id =
        type.equals("register")
            ? o.optString("registerId", o.optString("legacyRegisterId"))
            : Json.id(o);
    return new RowsAdapter.Row(type + ":" + id, title, detail, value, color, new Entry(type, o));
  }

  private void select(RowsAdapter.Row row) {
    if (!(row.data instanceof Entry)) return;
    Entry e = (Entry) row.data;
    JSONObject o = e.value;
    Snapshot data = a.controller.snapshot;
    a.safe(
        () -> {
          switch (e.kind) {
            case "tab":
              a.selectTab(Json.id(o));
              break;
            case "table":
              for (JSONObject tab : data.tabs)
                if (tab.optString("tableId").equals(Json.id(o))
                    && tab.optString("status").equals("open")) {
                  a.selectTab(Json.id(tab));
                  return;
                }
              a.forms.newTab(o);
              break;
            case "ticket":
              a.forms.ticket(o);
              break;
            case "print":
              a.forms.print(o);
              break;
            case "payment":
              if (o.optString("status").equals("approved") && o.optString("kind").equals("sale"))
                a.choose(
                    "Betalning",
                    new String[] {"Visa betalning", "Gör retur"},
                    i -> {
                      if (i == 0) a.forms.paymentResult(o);
                      else a.forms.refund(o);
                    });
              else a.forms.paymentResult(o);
              break;
            case "receipt":
              a.forms.receipt(o, data.prints);
              break;
            case "day":
              showReport(Json.id(o));
              break;
            case "register":
              a.textDialog("Kassarapport", reportText(o));
              break;
            case "journal":
              a.controller.read(
                  "/journal",
                  text -> {
                    JSONObject journal = Json.object(text);
                    StringBuilder s =
                        new StringBuilder(
                            "Journalens kontroll: "
                                + (journal.optBoolean("intact") ? "intakt" : "fel upptäckt")
                                + "\n\n");
                    List<JSONObject> entries = Json.list(journal, "entries");
                    for (int i = Math.max(0, entries.size() - 100); i < entries.size(); i++) {
                      JSONObject j = entries.get(i);
                      s.append(j.optString("at"))
                          .append(" · ")
                          .append(j.optString("action"))
                          .append("\n");
                    }
                    a.textDialog("Journal", s.toString());
                  });
              break;
            case "company":
              admin.company();
              break;
            case "menu":
              admin.menu(o);
              break;
            case "editTable":
              admin.table(o);
              break;
            case "staff":
              admin.staff(o);
              break;
            case "device":
              admin.device(o);
              break;
            case "printer":
              admin.printer(o);
              break;
          }
        });
  }

  private void showReport(String day) {
    a.controller.read(
        "/business-days/" + day + "/report",
        text -> {
          JSONObject report = Json.object(text);
          StringBuilder s =
              new StringBuilder(
                  "ÖVNING\nFörsäljning: "
                      + Money.format(report.optLong("salesOre"))
                      + "\nReturer: "
                      + Money.format(report.optLong("refundsOre"))
                      + "\nNetto: "
                      + Money.format(report.optLong("netOre"))
                      + "\nMoms: "
                      + Money.format(report.optLong("vatOre"))
                      + "\nDricks: "
                      + Money.format(report.optLong("tipsOre"))
                      + "\nFörväntat kontant: "
                      + Money.format(report.optLong("expectedCashOre"))
                      + "\n");
          for (JSONObject register : Json.list(report, "registers"))
            s.append("\n").append(reportText(register));
          a.textDialog("Dagsrapport", s.toString());
        });
  }

  private String reportText(JSONObject report) {
    return ReportText.register(report);
  }

  private void export() {
    Snapshot s = a.controller.snapshot;
    if (s.days.isEmpty()) {
      a.toast("Ingen verksamhetsdag finns.");
      return;
    }
    List<String> names = new ArrayList<>();
    for (JSONObject d : s.days) names.add(d.optString("date"));
    a.choose(
        "Välj dag",
        names.toArray(new String[0]),
        i -> {
          String day = Json.id(s.days.get(i));
          a.choose(
              "Exportera",
              new String[] {
                "Kassarapporter JSON", "Dagsrapport CSV", "Journal XML", "Journal JSON"
              },
              n -> {
                String path =
                    n == 0
                        ? "/business-days/" + day + "/register-reports.json"
                        : n == 1
                            ? "/business-days/" + day + "/report.csv"
                            : n == 2 ? "/journal.xml" : "/journal.json";
                String extension = n == 1 ? "csv" : n == 2 ? "xml" : "json";
                a.controller.export(
                    path,
                    text ->
                        a.saveText(
                            "restaurangkassa-" + day + "." + extension,
                            text,
                            n == 1 ? "text/csv" : n == 2 ? "application/xml" : "application/json"));
              });
        });
  }
}
