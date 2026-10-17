package se.restaurant.nativepos;

import android.view.*;
import android.widget.*;
import java.util.*;
import org.json.JSONObject;

/** Small native table buttons positioned using the restaurant's saved floor coordinates. */
public final class TableMapScreen implements MainActivity.Screen {
  private final MainActivity a;
  private final Ui ui;
  private final LinearLayout root, rooms;
  private final FrameLayout floor;
  private final TextView hint;
  private String area = "", signature = "";
  private final int width, baseHeight;

  public TableMapScreen(MainActivity a) {
    this.a = a;
    ui = a.ui;
    root = ui.column();
    ui.pad(root, 12);
    ui.full(root, ui.text("Bordskarta", 24, Ui.INK, true));
    hint = ui.label("Ledigt · Öppen nota");
    ui.full(root, hint);
    HorizontalScrollView areas = new HorizontalScrollView(a);
    rooms = ui.row();
    areas.addView(rooms);
    ui.full(root, areas);
    floor = new FrameLayout(a);
    floor.setBackground(ui.shape(Ui.PAPER, 8, true));
    floor.setContentDescription("Bordens placering");
    width = Math.max(560, a.getResources().getConfiguration().screenWidthDp - (a.counter() ? 132 : 32));
    baseHeight = Math.max(240, a.getResources().getConfiguration().screenHeightDp - (a.counter() ? 300 : 360));
    HorizontalScrollView horizontal = new HorizontalScrollView(a);
    horizontal.addView(floor, new ViewGroup.LayoutParams(ui.dp(width), ui.dp(baseHeight)));
    ui.weight(root, ui.scroll(horizontal));
    ui.full(root, ui.button("Till startsidan", false, a::leaveTab));
  }

  public View view() { return root; }

  public void bind(Snapshot data) {
    Set<String> names = new LinkedHashSet<>();
    for (JSONObject table : data.tables) if (table.optBoolean("active")) names.add(table.optString("area"));
    if (!names.contains(area)) area = names.isEmpty() ? "" : names.iterator().next();
    StringBuilder keyState = new StringBuilder(data.tables.toString()).append(area);
    for (JSONObject tab : data.tabs) if (tab.optString("status").equals("open"))
      keyState.append(Json.id(tab)).append(':').append(tab.optInt("version")).append(':').append(data.remaining(tab));
    String key = keyState.toString();
    if (key.equals(signature)) return;
    signature = key;
    rooms.removeAllViews();
    for (String name : names) {
      TextView button = ui.button(name, name.equals(area), () -> { area = name; bind(a.controller.snapshot); });
      rooms.addView(button, ui.lp(-2, 48));
    }
    floor.removeAllViews();
    List<android.graphics.Rect> used = new ArrayList<>();
    int height = baseHeight;
    for (JSONObject table : data.tables) {
      if (!table.optBoolean("active") || !area.equals(table.optString("area"))) continue;
      JSONObject tab = TableLookup.openTab(data.tabs, Json.id(table));
      String state = tab == null ? "Ledigt" : "Öppen · " + Money.format(data.remaining(tab));
      TextView button = ui.button(table.optString("name") + "\n" + state, false, () -> a.openTable(table));
      button.setTextSize(13);
      button.setContentDescription(table.optString("name") + ", " + state);
      button.setTextColor(tab == null ? Ui.INK : Ui.TILE_INK);
      button.setBackground(ui.shape(tab == null ? Ui.RAISED : Ui.GREEN, 8, true));
      int x = Math.max(8, Math.min(width - 104, (int) (table.optDouble("x", 50) * (width - 112) / 100) + 8));
      int y = Math.max(8, Math.min(baseHeight - 80, (int) (table.optDouble("y", 50) * (baseHeight - 88) / 100) + 8));
      android.graphics.Rect rect = new android.graphics.Rect(x, y, x + 100, y + 80);
      // Keep all configured tables reachable even when their saved coordinates overlap.
      boolean collision;
      do {
        collision = false;
        for (android.graphics.Rect other : used) if (android.graphics.Rect.intersects(rect, other)) {
          rect.offset(0, 84); collision = true; break;
        }
      } while (collision);
      used.add(rect);
      height = Math.max(height, rect.bottom + 8);
      FrameLayout.LayoutParams p = new FrameLayout.LayoutParams(ui.dp(96), ui.dp(72));
      p.leftMargin = ui.dp(rect.left);
      p.topMargin = ui.dp(rect.top);
      floor.addView(button, p);
    }
    floor.getLayoutParams().height = ui.dp(height);
    floor.requestLayout();
    hint.setText(names.isEmpty() ? "Inga aktiva bord. Be ansvarig lägga till bord."
        : "Grönt = öppen nota · Grått = ledigt\nTryck på ett bord för att öppna det.");
  }
}
