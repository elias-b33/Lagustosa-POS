package se.restaurant.nativepos;

import android.view.*;
import android.widget.*;
import androidx.recyclerview.widget.*;
import org.json.JSONObject;

/** Recycled order rows with permanent touch targets; no hidden removal gesture. */
public final class OrderAdapter extends androidx.recyclerview.widget.ListAdapter<RowsAdapter.Row, OrderAdapter.Holder> {
  private final MainActivity a;
  private final Ui ui;
  private boolean writable, manager, locked;

  public OrderAdapter(MainActivity a) {
    super(new DiffUtil.ItemCallback<RowsAdapter.Row>() {
      public boolean areItemsTheSame(RowsAdapter.Row x, RowsAdapter.Row y) { return x.id.equals(y.id); }
      public boolean areContentsTheSame(RowsAdapter.Row x, RowsAdapter.Row y) { return x.signature.equals(y.signature); }
    });
    this.a = a;
    ui = a.ui;
    setHasStableIds(true);
    setStateRestorationPolicy(StateRestorationPolicy.PREVENT_WHEN_EMPTY);
  }

  public void context(boolean writable, boolean manager, boolean locked) {
    if (this.writable == writable && this.manager == manager && this.locked == locked) return;
    this.writable = writable;
    this.manager = manager;
    this.locked = locked;
    notifyItemRangeChanged(0, getItemCount(), "permissions");
  }

  public long getItemId(int position) { return ProductAdapter.stableId(getItem(position).id); }
  public Holder onCreateViewHolder(ViewGroup parent, int type) { return new Holder(); }

  public void onBindViewHolder(Holder h, int position) {
    RowsAdapter.Row r = getItem(position);
    JSONObject line = (JSONObject) r.data;
    boolean sent = !line.optString("status").equals("draft") && !line.optString("status").equals("held");
    String restriction = locked ? "Betalning påbörjad – raden är låst" : sent && !manager ? "Ansvarig krävs för att ta bort skickat" : "";
    h.title.setText(r.title);
    h.detail.setText(r.detail + (restriction.isEmpty() ? "" : "\n" + restriction));
    h.price.setText(r.value);
    h.texts.setContentDescription(r.title + ", " + r.detail + ", " + r.value);
    h.minus.setContentDescription("Minska antal " + line.optString("name"));
    h.remove.setContentDescription("Ta bort " + line.optString("name"));
    ui.enable(h.minus, writable && restriction.isEmpty());
    ui.enable(h.remove, writable && restriction.isEmpty());
  }

  final class Holder extends RecyclerView.ViewHolder {
    final TextView title, detail, price, minus, remove;
    final LinearLayout texts;
    Holder() {
      super(ui.column());
      LinearLayout row = (LinearLayout) itemView;
      ui.pad(row, 8);
      RecyclerView.LayoutParams p = new RecyclerView.LayoutParams(-1, -2);
      p.bottomMargin = ui.dp(6);
      row.setLayoutParams(p);
      row.setBackground(ui.shape(Ui.RAISED, 6, false));
      texts = ui.column();
      title = ui.text("", 16, Ui.INK, true);
      detail = ui.text("", 12, Ui.MUTED, false);
      ui.full(texts, title);
      ui.full(texts, detail);
      ui.full(row, texts);
      texts.setMinimumHeight(ui.dp(48));
      texts.setFocusable(true);
      texts.setOnClickListener(v -> act(0));
      LinearLayout controls = ui.row();
      price = ui.text("", 16, ui.accent, true);
      controls.addView(price, new LinearLayout.LayoutParams(0, -2, 1));
      minus = ui.button("−", false, () -> act(1));
      minus.setTextSize(26);
      controls.addView(minus, ui.lp(52, 48));
      remove = ui.button("Ta bort", false, () -> act(2));
      remove.setTextColor(Ui.DANGER);
      controls.addView(remove, ui.lp(90, 48));
      ui.full(row, controls);
    }
    private void act(int action) {
      int index = getBindingAdapterPosition();
      if (index == RecyclerView.NO_POSITION) return;
      JSONObject line = (JSONObject) getItem(index).data;
      if (action == 0) a.forms.line(line, a.tab());
      else a.forms.removeLine(line, a.tab(), action == 1);
    }
  }
}
