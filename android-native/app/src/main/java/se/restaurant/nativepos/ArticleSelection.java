package se.restaurant.nativepos;

import android.text.*;
import android.view.*;
import android.widget.*;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;
import java.util.*;
import org.json.*;

/** Bounded native rows even when a large bill is split or returned. */
public final class ArticleSelection extends LinearLayout {
  private final List<JSONObject> lines;
  private final Map<String, Integer> quantities = new HashMap<>();
  private final Set<String> checked = new HashSet<>();
  private final Ui ui;
  private final RecyclerView list;
  private boolean byQuantity;

  public ArticleSelection(Ui ui, List<JSONObject> rows) {
    super(ui.context);
    this.ui = ui;
    this.lines = rows;
    setOrientation(VERTICAL);
    TextView hint =
        ui.label("Välj artikelrader. Återstående belopp och antal kontrolleras av kassaservern.");
    addView(hint, ui.lp(-1, -2));
    list = new RecyclerView(ui.context);
    list.setLayoutManager(new LinearLayoutManager(ui.context));
    list.setItemAnimator(null);
    list.setHasFixedSize(true);
    list.setAdapter(
        new RecyclerView.Adapter<Holder>() {
          public Holder onCreateViewHolder(ViewGroup parent, int type) {
            return new Holder();
          }

          public int getItemCount() {
            return lines.size();
          }

          public void onBindViewHolder(Holder holder, int position) {
            holder.bind(lines.get(position));
          }
        });
    addView(list, ui.lp(-1, Math.min(280, Math.max(64, rows.size() * 64))));
  }

  public void mode(boolean quantities) {
    if (byQuantity == quantities) return;
    byQuantity = quantities;
    list.getAdapter().notifyItemRangeChanged(0, lines.size(), "mode");
  }

  public JSONArray ids() {
    JSONArray result = new JSONArray();
    for (JSONObject line : lines) if (checked.contains(Json.id(line))) result.put(Json.id(line));
    if (result.length() == 0) throw new IllegalArgumentException("Välj minst en artikelrad.");
    return result;
  }

  public JSONArray items() {
    JSONArray result = new JSONArray();
    for (JSONObject line : lines) {
      String id = Json.id(line);
      if (checked.contains(id)) {
        int count = quantities.getOrDefault(id, 1);
        if (count < 1 || count > 100)
          throw new IllegalArgumentException("Ange mellan 1 och 100 av varje vald artikel.");
        result.put(Json.obj("lineId", id, "quantity", count));
      }
    }
    if (result.length() == 0) throw new IllegalArgumentException("Välj minst en artikel.");
    return result;
  }

  private final class Holder extends RecyclerView.ViewHolder {
    final CheckBox selected;
    final EditText quantity;
    String id = "";
    boolean binding;

    Holder() {
      super(ui.row());
      LinearLayout row = (LinearLayout) itemView;
      selected = new CheckBox(ui.context);
      selected.setTextColor(Ui.INK);
      selected.setTextSize(14);
      selected.setMaxLines(2);
      row.addView(selected, new LinearLayout.LayoutParams(0, ui.dp(64), 1));
      quantity = ui.input("1", "Antal", InputType.TYPE_CLASS_NUMBER);
      row.addView(quantity, ui.lp(64, 48));
      selected.setOnCheckedChangeListener(
          (button, value) -> {
            if (!binding) {
              if (value) checked.add(id);
              else checked.remove(id);
            }
          });
      quantity.addTextChangedListener(
          new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int st, int count, int after) {}

            public void onTextChanged(CharSequence s, int st, int before, int count) {
              if (!binding) {
                try {
                  quantities.put(id, Integer.parseInt(s.toString()));
                } catch (NumberFormatException e) {
                  quantities.put(id, 0);
                }
              }
            }

            public void afterTextChanged(Editable value) {}
          });
    }

    void bind(JSONObject line) {
      binding = true;
      id = Json.id(line);
      selected.setText(line.optInt("quantity", 1) + " × " + line.optString("name"));
      selected.setChecked(checked.contains(id));
      quantity.setText(String.valueOf(quantities.getOrDefault(id, 1)));
      quantity.setContentDescription("Antal · " + line.optString("name"));
      quantity.setVisibility(byQuantity ? View.VISIBLE : View.GONE);
      binding = false;
    }
  }
}
