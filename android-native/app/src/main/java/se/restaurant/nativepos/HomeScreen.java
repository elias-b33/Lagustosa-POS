package se.restaurant.nativepos;

import android.text.*;
import android.view.*;
import android.widget.*;
import androidx.recyclerview.widget.RecyclerView;
import java.util.*;
import org.json.JSONObject;

/** A neutral landing screen: selecting a table is always an explicit action. */
public final class HomeScreen implements MainActivity.Screen {
  private final MainActivity a;
  private final Ui ui;
  private final LinearLayout root, choose;
  private final EditText number;
  private final TextView summary, empty, open, create, back;
  private final RowsAdapter bills;
  private final RecyclerView list;
  private boolean expanded;

  public HomeScreen(MainActivity a) {
    this.a = a;
    ui = a.ui;
    root = a.counter() ? ui.row() : ui.column();
    ui.pad(root, a.counter() ? 12 : 8);
    choose = ui.column();
    ui.pad(choose, a.counter() ? 8 : 0);
    if (a.counter()) root.addView(ui.scroll(choose), ui.lp(340, -1));
    else ui.full(root, choose);
    if (a.counter()) ui.full(choose, ui.text("Öppna ett bord", 24, Ui.INK, true));
    TextView neutral = ui.text("Ingen nota vald", 14, Ui.GREEN, false);
    neutral.setContentDescription("Ingen nota vald");
    if (a.counter()) ui.full(choose, neutral);
    else root.addView(neutral, 0, ui.lp(-1, -2));
    ui.gap(choose, 8);
    number = ui.input("", "Bordsnummer", android.text.InputType.TYPE_CLASS_NUMBER);
    number.setShowSoftInputOnFocus(false);
    number.setFilters(new InputFilter[] {new InputFilter.LengthFilter(6)});
    number.setTextSize(24);
    number.setGravity(Gravity.CENTER);
    LinearLayout entry = ui.row();
    entry.addView(number, new LinearLayout.LayoutParams(0, ui.dp(48), 1));
    open = ui.button("Öppna bord", true, this::openNumber);
    entry.addView(open, ui.lp(136, 48));
    ui.full(choose, entry);
    for (String[] row : new String[][] {{"1","2","3"},{"4","5","6"},{"7","8","9"},{"Rensa","0","⌫"}}) {
      LinearLayout keys = ui.row();
      for (String digit : row) {
        TextView key = ui.button(digit, false, () -> {
          String value = number.getText().toString();
          number.setText(digit.equals("Rensa") ? "" : digit.equals("⌫")
              ? value.substring(0, Math.max(0, value.length() - 1)) : value + digit);
          number.setSelection(number.length());
        });
        key.setContentDescription(digit.equals("⌫") ? "Radera sista siffran" : digit);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, ui.dp(48), 1);
        p.setMargins(ui.dp(2), ui.dp(2), ui.dp(2), 0);
        keys.addView(key, p);
      }
      ui.full(choose, keys);
    }
    ui.gap(choose, 6);
    LinearLayout actions = ui.row();
    actions.addView(ui.button("Bordskarta", false, () -> a.navigate("tables")), new LinearLayout.LayoutParams(0, ui.dp(48), 1));
    create = ui.button("+ Disknota", false, () -> a.forms.newTab(null));
    actions.addView(create, new LinearLayout.LayoutParams(0, ui.dp(48), 1));
    ui.full(choose, actions);
    LinearLayout saved = ui.column();
    ui.pad(saved, 8);
    ui.weight(root, saved);
    summary = a.counter() ? ui.text("Öppna notor", 19, Ui.INK, true)
        : ui.button("Öppna notor", false, () -> showBills(true));
    if (!a.counter()) summary.setContentDescription("Visa alla öppna notor");
    ui.full(saved, summary);
    empty = ui.label("");
    ui.full(saved, empty);
    bills = new RowsAdapter(ui, row -> a.selectTab(row.id));
    list = RowsAdapter.list(ui, bills);
    list.setContentDescription("Öppna notor");
    ui.weight(saved, list);
    back = ui.button("‹ Bordsnummer", false, () -> showBills(false));
    ui.full(saved, back);
    showBills(false);
  }

  private void showBills(boolean show) {
    expanded = show;
    choose.setVisibility(show && !a.counter() ? View.GONE : View.VISIBLE);
    list.setVisibility(show || a.counter() ? View.VISIBLE : View.GONE);
    back.setVisibility(show && !a.counter() ? View.VISIBLE : View.GONE);
  }

  public boolean back() {
    if (!expanded || a.counter()) return false;
    showBills(false);
    return true;
  }

  private void openNumber() {
    Snapshot data = a.controller.snapshot;
    if (data == null) return;
    List<JSONObject> matches = TableLookup.matching(data.tables, number.getText().toString());
    if (matches.isEmpty()) {
      number.setError("Bordet finns inte. Välj ett annat nummer eller öppna bordskartan.");
      return;
    }
    if (matches.size() == 1) a.openTable(matches.get(0));
    else {
      String[] names = new String[matches.size()];
      for (int i = 0; i < names.length; i++) names[i] = matches.get(i).optString("name") + " · " + matches.get(i).optString("area");
      a.choose("Välj bordets område", names, i -> a.openTable(matches.get(i)));
    }
  }

  public View view() { return root; }

  public void bind(Snapshot data) {
    List<RowsAdapter.Row> rows = new ArrayList<>();
    int tableCount = 0, counterCount = 0;
    for (JSONObject tab : data.tabs) if (tab.optString("status").equals("open")) {
      if (tab.isNull("tableId")) counterCount++; else tableCount++;
      int drafts = 0;
      for (JSONObject line : Json.list(tab, "lines")) if (line.optString("status").equals("draft")) drafts++;
      String detail = tab.optInt("guestCount") + " gäster · " + (drafts > 0 ? "Ej skickade artiklar" : "Öppen nota");
      if (data.lockedTabs.contains(Json.id(tab))) detail = "Betalning påbörjad · öppna för att kontrollera";
      rows.add(new RowsAdapter.Row(Json.id(tab), tab.optString("label"), detail, Money.format(data.remaining(tab)), Ui.INK, tab));
    }
    bills.submitList(rows);
    summary.setText("Öppna notor · " + rows.size());
    empty.setText(data.day == null ? "Dagen är stängd. Be ansvarig öppna dagen."
        : rows.isEmpty() ? "Inga öppna notor" : tableCount + " bord · " + counterCount + " disknotor");
    ui.enable(open, !data.tables.isEmpty());
    ui.enable(create, a.controller.writable() && data.day != null);
  }
}
