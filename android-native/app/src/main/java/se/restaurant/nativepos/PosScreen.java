package se.restaurant.nativepos;

import android.os.Handler;
import android.os.Looper;
import android.text.*;
import android.view.*;
import android.widget.*;
import androidx.recyclerview.widget.*;
import java.util.*;
import java.util.concurrent.*;
import org.json.JSONObject;

public final class PosScreen implements MainActivity.Screen {
  private final MainActivity a;
  private final Ui ui;
  private final LinearLayout root, menu, order, categories, actions, cart;
  private final TextView heading, total, dayNotice, send, pay, split, cartText, leave;
  private final Spinner tabs;
  private final ProductAdapter products;
  private final OrderAdapter lines;
  private final RecyclerView grid, lineList;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private static final ExecutorService FILTERS = Executors.newSingleThreadExecutor();
  private String category = "Alla", query = "", tabsSignature = "", selected = "";
  private List<Snapshot.Product> source = Collections.emptyList();
  private List<String> tabIds = Collections.emptyList();
  private boolean orderShown, spinnerBinding;
  private int filterGeneration;

  public PosScreen(MainActivity a) {
    this.a = a;
    ui = a.ui;
    root = ui.column();
    ui.pad(root, 8);
    dayNotice =
        ui.button("Öppna dagen för att börja ta beställningar", false, () -> a.navigate("reports"));
    ui.full(root, dayNotice);
    leave = ui.button("‹ Lämna nota", false, a::leaveTab);
    leave.setContentDescription("Lämna nota");
    ui.full(root, leave);
    LinearLayout panes = ui.row();
    ui.weight(root, panes);
    menu = ui.column();
    panes.addView(menu, new LinearLayout.LayoutParams(0, -1, 1));
    tabs = ui.select(menu, "", Collections.singletonList("Välj en öppen nota"), 0);
    tabs.setContentDescription("Välj nota");
    tabs.setOnItemSelectedListener(
        new AdapterView.OnItemSelectedListener() {
          public void onItemSelected(AdapterView<?> p, View v, int position, long id) {
            if (!spinnerBinding
                && position < tabIds.size()
                && position != Math.max(0, tabIds.indexOf(a.selectedTab)))
              a.selectTab(tabIds.get(position));
          }

          public void onNothingSelected(AdapterView<?> p) {}
        });
    LinearLayout tools = ui.row();
    EditText search = ui.input("", "Sök i menyn", android.text.InputType.TYPE_CLASS_TEXT);
    search.setTextSize(14);
    tools.addView(search, new LinearLayout.LayoutParams(0, ui.dp(48), 1));
    tools.addView(ui.button("+ Ny nota", true, () -> a.forms.newTab(null)), ui.lp(-2, 48));
    ui.gap(menu, 8);
    ui.full(menu, tools);
    search.addTextChangedListener(
        new TextWatcher() {
          public void beforeTextChanged(CharSequence s, int st, int c, int af) {}

          public void onTextChanged(CharSequence s, int st, int b, int c) {
            query = s.toString().trim().toLowerCase(Locale.ROOT);
            filter();
          }

          public void afterTextChanged(Editable e) {}
        });
    HorizontalScrollView scroll = new HorizontalScrollView(a);
    scroll.setHorizontalScrollBarEnabled(false);
    categories = ui.row();
    scroll.addView(categories);
    menu.addView(scroll, ui.lp(-1, 56));
    products =
        new ProductAdapter(
            ui,
            p -> {
              JSONObject tab = a.tab();
              if (tab == null || !tab.optString("status").equals("open")) a.forms.newTab(null);
              else a.forms.item(p, tab);
            });
    grid = new RecyclerView(a);
    grid.setContentDescription("Artikelmeny");
    int orderWidth = Math.min(344, a.getResources().getConfiguration().screenWidthDp / 3);
    int available =
        a.getResources().getConfiguration().screenWidthDp - (a.counter() ? orderWidth + 116 : 16);
    int columns = Math.max(2, available / 150);
    grid.setLayoutManager(new GridLayoutManager(a, columns));
    grid.setAdapter(products);
    grid.setHasFixedSize(true);
    grid.setItemAnimator(null);
    grid.setItemViewCacheSize(columns * 2);
    grid.setClipToPadding(false);
    ui.weight(menu, grid);
    order = ui.column();
    ui.pad(order, 12);
    order.setBackground(ui.shape(Ui.PAPER, 8, false));
    panes.addView(
        order, a.counter() ? ui.lp(orderWidth, -1) : new LinearLayout.LayoutParams(0, -1, 1));
    if (!a.counter()) ui.full(order, ui.button("‹ Till menyn", false, () -> showOrder(false)));
    heading = ui.text("Välj en nota", 22, Ui.INK, true);
    ui.full(order, heading);
    ui.full(
        order,
        ui.button(
            "Gäster · flytta · rabatt",
            false,
            () -> {
              if (a.tab() != null) a.forms.tabOptions(a.tab());
            }));
    lines = new OrderAdapter(a);
    lineList = RowsAdapter.list(ui, lines);
    lineList.setContentDescription("Aktuell nota");
    ui.weight(order, lineList);
    total = ui.text("", 26, Ui.INK, true);
    ui.full(order, total);
    actions = ui.column();
    ui.full(order, actions);
    send =
        ui.button(
            "Skicka till kök & bar",
            false,
            () -> {
              JSONObject tab = a.tab();
              if (tab != null) a.command(tab, Json.obj("action", "send"), "Skicka beställning");
            });
    pay =
        ui.button(
            "Ta betalt",
            true,
            () -> {
              if (a.tab() != null) a.forms.payment(a.tab());
            });
    ui.full(actions, send);
    ui.gap(actions, 6);
    split = ui.button("Dela nota", false, () -> {
      if (a.tab() != null) a.forms.payment(a.tab(), 2);
    });
    LinearLayout paymentButtons = ui.row();
    paymentButtons.addView(split, new LinearLayout.LayoutParams(0, ui.dp(48), 1));
    paymentButtons.addView(pay, new LinearLayout.LayoutParams(0, ui.dp(48), 1));
    ui.full(actions, paymentButtons);
    cart = ui.row();
    cart.setBackgroundColor(Ui.PAPER);
    ui.pad(cart, 6);
    cartText = ui.text("", 13, Ui.INK, true);
    cart.addView(cartText, new LinearLayout.LayoutParams(0, -2, 1));
    cart.addView(ui.button("Visa nota", true, () -> showOrder(true)), ui.lp(120, 48));
    root.addView(cart, ui.lp(-1, 62));
    showOrder(false);
  }

  public View view() {
    return root;
  }

  public void addDiagnostics(JSONObject report) {
    Json.put(report, "articles", products.getItemCount());
    Json.put(report, "visibleHolders", grid.getChildCount());
    Json.put(report, "createdHolders", products.createdHolders);
  }

  public void bind(Snapshot data) {
    dayNotice.setVisibility(data.day == null ? View.VISIBLE : View.GONE);
    JSONObject tab = a.tab();
    boolean open = tab != null && tab.optString("status").equals("open");
    leave.setText(open ? "‹ Lämna nota · " + tab.optString("label") : "‹ Till startsidan");
    ui.enable(leave, !a.controller.busy);
    lines.context(a.controller.writable() && open, data.manager(), open && data.lockedTabs.contains(Json.id(tab)));
    if (!selected.equals(a.selectedTab)) {
      selected = a.selectedTab;
      showOrder(false);
    }
    List<String> ids = new ArrayList<>(), names = new ArrayList<>();
    ids.add("");
    names.add("Välj en öppen nota");
    for (JSONObject t : data.tabs)
      if (t.optString("status").equals("open")) {
        ids.add(Json.id(t));
        names.add(t.optString("label") + " · " + Money.format(data.remaining(t)));
      }
    if (tab != null && !open) {
      ids.add(Json.id(tab));
      names.add(tab.optString("label") + " · avslutad");
    }
    String signature = names.toString() + a.selectedTab;
    if (!signature.equals(tabsSignature)) {
      tabsSignature = signature;
      tabIds = ids;
      spinnerBinding = true;
      ArrayAdapter<String> adapter =
          new ArrayAdapter<>(a, android.R.layout.simple_spinner_item, names);
      adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
      tabs.setAdapter(adapter);
      tabs.setSelection(Math.max(0, ids.indexOf(a.selectedTab)));
      tabs.post(() -> spinnerBinding = false);
    }
    if (source != data.products) {
      source = data.products;
      buildCategories(data);
      filter();
    }
    products.context(
        a.controller.writable()
            && data.day != null
            && (!open || !data.lockedTabs.contains(Json.id(tab))),
        open && tab.optString("serviceMode").equals("takeaway"));
    heading.setText(tab == null ? "Välj en nota" : tab.optString("label"));
    List<RowsAdapter.Row> rows = new ArrayList<>();
    int draft = 0, held = 0, count = 0;
    if (tab != null)
      for (JSONObject line : Json.list(tab, "lines"))
        if (!line.optString("status").equals("void")) {
          String state = line.optString("status");
          if (state.equals("draft")) draft++;
          if (state.equals("held")) held++;
          count += line.optInt("quantity");
          String details =
              (line.optInt("guest") == 0 ? "Gemensamt" : "Gäst " + line.optInt("guest"))
                  + " · "
                  + Forms.status(state);
          if (!line.optString("notes").isEmpty()) details += "\n" + line.optString("notes");
          rows.add(
              new RowsAdapter.Row(
                  Json.id(line),
                  line.optInt("quantity") + " × " + line.optString("name"),
                  details,
                  Money.format(line.optLong("unitPriceOre") * line.optInt("quantity")),
                  Ui.INK,
                  line));
        }
    lines.submitList(rows);
    long remaining = tab == null ? 0 : data.remaining(tab);
    total.setText("Kvar  " + Money.format(remaining));
    cartText.setText(
        (tab == null ? "" : tab.optString("label"))
            + " · "
            + count
            + " st\n"
            + Money.format(remaining));
    send.setVisibility(draft > 0 ? View.VISIBLE : View.GONE);
    ui.enable(send, a.controller.writable() && open);
    pay.setVisibility(open ? View.VISIBLE : View.GONE);
    ui.enable(pay, a.controller.writable() && open && count > 0 && draft == 0 && held == 0);
    split.setVisibility(open ? View.VISIBLE : View.GONE);
    ui.enable(split, a.controller.writable() && open && count > 0 && draft == 0 && held == 0);
    while (actions.getChildCount() > 3) actions.removeViewAt(3);
    if (held > 0 && open) {
      Set<String> courses = new LinkedHashSet<>();
      for (JSONObject line : Json.list(tab, "lines"))
        if (line.optString("status").equals("held")) courses.add(line.optString("course"));
      String[] courseIds = courses.toArray(new String[0]);
      String[] labels = new String[courseIds.length];
      for (int i = 0; i < courseIds.length; i++) labels[i] = Forms.course(courseIds[i]);
      // A row of buttons per course would squeeze the order list off a small handset.
      TextView fire = ui.button(courseIds.length == 1 ? "Slå ut " + labels[0] : "Slå ut väntande rätter", false, () -> {
        if (courseIds.length == 1) a.command(a.tab(), Json.obj("action", "fire", "course", courseIds[0]), "Slå ut rätt");
        else a.choose("Vilken rätt ska slås ut?", labels,
            i -> a.command(a.tab(), Json.obj("action", "fire", "course", courseIds[i]), "Slå ut rätt"));
      });
      ui.enable(fire, a.controller.writable());
      ui.full(actions, fire);
    }
    cart.setVisibility(!a.counter() && !orderShown && open ? View.VISIBLE : View.GONE);
  }

  private void buildCategories(Snapshot data) {
    if (!data.categories.contains(category)) category = "Alla";
    categories.removeAllViews();
    for (int i = 0; i < data.categories.size(); i++) {
      String name = data.categories.get(i);
      TextView b =
          ui.button(
              name,
              false,
              () -> {
                category = name;
                buildCategories(a.controller.snapshot);
                filter();
              });
      if (name.equals(category)) {
        b.setTextColor(Ui.TILE_INK);
        b.setBackground(ui.shape(i == 0 ? ui.accent : Ui.TONES[(i - 1) % 6], 6, false));
      }
      LinearLayout.LayoutParams p = ui.lp(-2, 44);
      p.setMargins(ui.dp(3), ui.dp(5), ui.dp(3), ui.dp(5));
      categories.addView(b, p);
    }
  }

  private void filter() {
    int generation = ++filterGeneration;
    String text = query, group = category;
    List<Snapshot.Product> all = source;
    FILTERS.execute(
        () -> {
          List<Snapshot.Product> found = new ArrayList<>();
          for (Snapshot.Product product : all)
            if ((group.equals("Alla") || product.category.equals(group))
                && (text.isEmpty() || product.search.contains(text))) found.add(product);
          handler.post(
              () -> {
                if (generation == filterGeneration) products.submitList(found);
              });
        });
  }

  private void showOrder(boolean show) {
    orderShown = show;
    menu.setVisibility(!show || a.counter() ? View.VISIBLE : View.GONE);
    order.setVisibility(show || a.counter() ? View.VISIBLE : View.GONE);
    JSONObject tab = a.tab();
    cart.setVisibility(
        !a.counter() && !show && tab != null && tab.optString("status").equals("open")
            ? View.VISIBLE
            : View.GONE);
  }

  public boolean back() {
    if (orderShown && !a.counter()) {
      showOrder(false);
      return true;
    }
    return false;
  }
}
