package se.restaurant.nativepos;

import android.text.TextUtils;
import android.view.*;
import android.widget.*;
import androidx.recyclerview.widget.*;
import java.util.function.Consumer;

public final class RowsAdapter
    extends androidx.recyclerview.widget.ListAdapter<RowsAdapter.Row, RowsAdapter.Holder> {
  public static final class Row {
    public final String id, title, detail, value, signature;
    public final int color;
    public final Object data;

    public Row(String id, String title, String detail, String value, int color, Object data) {
      this.id = id;
      this.title = title;
      this.detail = detail;
      this.value = value;
      this.color = color;
      this.data = data;
      signature = title + '\0' + detail + '\0' + value + '\0' + color;
    }
  }

  private final Ui ui;
  private final Consumer<Row> click;

  public RowsAdapter(Ui ui, Consumer<Row> click) {
    super(
        new DiffUtil.ItemCallback<Row>() {
          public boolean areItemsTheSame(Row a, Row b) {
            return a.id.equals(b.id);
          }

          public boolean areContentsTheSame(Row a, Row b) {
            return a.signature.equals(b.signature);
          }
        });
    this.ui = ui;
    this.click = click;
    setHasStableIds(true);
    setStateRestorationPolicy(StateRestorationPolicy.PREVENT_WHEN_EMPTY);
  }

  @Override
  public long getItemId(int position) {
    return ProductAdapter.stableId(getItem(position).id);
  }

  @Override
  public Holder onCreateViewHolder(ViewGroup parent, int type) {
    return new Holder(ui);
  }

  @Override
  public void onBindViewHolder(Holder h, int position) {
    Row r = getItem(position);
    h.title.setText(r.title);
    h.detail.setText(r.detail);
    h.value.setText(r.value);
    h.value.setTextColor(r.color);
    h.itemView.setContentDescription(r.title + ", " + r.detail + ", " + r.value);
    h.itemView.setOnClickListener(
        v -> {
          int i = h.getBindingAdapterPosition();
          if (i != RecyclerView.NO_POSITION) click.accept(getItem(i));
        });
  }

  static final class Holder extends RecyclerView.ViewHolder {
    final TextView title, detail, value;

    Holder(Ui ui) {
      super(ui.row());
      LinearLayout row = (LinearLayout) itemView;
      ui.pad(row, 12);
      row.setMinimumHeight(ui.dp(76));
      RecyclerView.LayoutParams p = new RecyclerView.LayoutParams(-1, -2);
      p.bottomMargin = ui.dp(6);
      row.setLayoutParams(p);
      row.setBackground(ui.shape(Ui.PAPER, 6, false));
      row.setFocusable(true);
      row.setClickable(true);
      LinearLayout texts = ui.column();
      row.addView(texts, new LinearLayout.LayoutParams(0, -2, 1));
      title = ui.text("", 15, Ui.INK, true);
      title.setMaxLines(2);
      title.setEllipsize(TextUtils.TruncateAt.END);
      ui.full(texts, title);
      detail = ui.text("", 12, Ui.MUTED, false);
      detail.setMaxLines(4);
      detail.setEllipsize(TextUtils.TruncateAt.END);
      ui.full(texts, detail);
      value = ui.text("", 15, Ui.ACCENT, true);
      value.setGravity(Gravity.END);
      value.setPadding(ui.dp(8), 0, 0, 0);
      row.addView(value, ui.lp(-2, -2));
    }
  }

  public static RecyclerView list(Ui ui, RecyclerView.Adapter<?> adapter) {
    RecyclerView list = new RecyclerView(ui.context);
    list.setLayoutManager(new LinearLayoutManager(ui.context));
    list.setAdapter(adapter);
    list.setItemAnimator(null);
    list.setHasFixedSize(true);
    list.setClipToPadding(false);
    return list;
  }
}
