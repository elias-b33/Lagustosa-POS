package se.restaurant.nativepos;

import android.text.TextUtils;
import android.view.*;
import android.widget.*;
import androidx.recyclerview.widget.*;
import java.util.function.Consumer;

/** Only visible cells exist. Search and data diffs run on workers; binds allocate no formatters. */
public final class ProductAdapter
    extends androidx.recyclerview.widget.ListAdapter<Snapshot.Product, ProductAdapter.Holder> {
  private final Ui ui;
  private final Consumer<Snapshot.Product> click;
  private boolean enabled, takeaway;
  private RecyclerView recycler;
  public int createdHolders;

  public ProductAdapter(Ui ui, Consumer<Snapshot.Product> click) {
    super(
        new DiffUtil.ItemCallback<Snapshot.Product>() {
          public boolean areItemsTheSame(Snapshot.Product a, Snapshot.Product b) {
            return a.id.equals(b.id);
          }

          public boolean areContentsTheSame(Snapshot.Product a, Snapshot.Product b) {
            return a.signature.equals(b.signature);
          }
        });
    this.ui = ui;
    this.click = click;
    setHasStableIds(true);
    setStateRestorationPolicy(StateRestorationPolicy.PREVENT_WHEN_EMPTY);
  }

  public static long stableId(String text) {
    long h = 0xcbf29ce484222325L;
    for (int i = 0; i < text.length(); i++) {
      h ^= text.charAt(i);
      h *= 0x100000001b3L;
    }
    return h;
  }

  @Override
  public long getItemId(int position) {
    return stableId(getItem(position).id);
  }

  @Override
  public void onAttachedToRecyclerView(RecyclerView view) {
    recycler = view;
  }

  public void context(boolean enabled, boolean takeaway) {
    boolean priceChanged = this.takeaway != takeaway;
    this.enabled = enabled;
    this.takeaway = takeaway;
    if (recycler == null) return;
    for (int i = 0; i < recycler.getChildCount(); i++) {
      Holder h = (Holder) recycler.getChildViewHolder(recycler.getChildAt(i));
      int position = h.getBindingAdapterPosition();
      if (position != RecyclerView.NO_POSITION) {
        ui.enable(h.card, enabled && getItem(position).available);
        if (priceChanged)
          h.price.setText(takeaway ? getItem(position).takeawayPrice : getItem(position).price);
      }
    }
  }

  @Override
  public Holder onCreateViewHolder(ViewGroup parent, int type) {
    createdHolders++;
    Holder holder = new Holder(ui);
    holder.card.setOnClickListener(
        v -> {
          int at = holder.getBindingAdapterPosition();
          if (enabled && at != RecyclerView.NO_POSITION && getItem(at).available)
            click.accept(getItem(at));
        });
    return holder;
  }

  @Override
  public void onBindViewHolder(Holder h, int position) {
    Snapshot.Product p = getItem(position);
    h.name.setText(p.name);
    h.description.setText(p.description);
    h.price.setText(takeaway ? p.takeawayPrice : p.price);
    h.background.setColor(p.available ? Ui.TONES[p.tone] : Ui.RAISED);
    int ink = p.available ? Ui.TILE_INK : Ui.MUTED;
    h.name.setTextColor(ink);
    h.description.setTextColor(ink);
    h.price.setTextColor(ink);
    h.card.setContentDescription(p.name + ", " + (takeaway ? p.takeawayPrice : p.price));
    ui.enable(h.card, enabled && p.available);
  }

  static final class Holder extends RecyclerView.ViewHolder {
    final LinearLayout card;
    final TextView name, description, price;
    final android.graphics.drawable.GradientDrawable background;

    Holder(Ui ui) {
      super(new FrameLayout(ui.context));
      FrameLayout outer = (FrameLayout) itemView;
      outer.setLayoutParams(new RecyclerView.LayoutParams(-1, ui.dp(118)));
      outer.setPadding(ui.dp(4), ui.dp(4), ui.dp(4), ui.dp(4));
      card = ui.column();
      ui.pad(card, 12);
      outer.addView(card, new FrameLayout.LayoutParams(-1, -1));
      card.setFocusable(true);
      card.setClickable(true);
      background = ui.shape(Ui.RAISED, 6, false);
      card.setBackground(background);
      card.setForeground(
          new android.graphics.drawable.RippleDrawable(
              android.content.res.ColorStateList.valueOf(0x22000000),
              null,
              ui.shape(0xffffffff, 6, false)));
      name = ui.text("", 15, Ui.TILE_INK, true);
      name.setMaxLines(2);
      name.setEllipsize(TextUtils.TruncateAt.END);
      ui.full(card, name);
      description = ui.text("", 11, Ui.TILE_INK, false);
      description.setMaxLines(1);
      description.setEllipsize(TextUtils.TruncateAt.END);
      ui.full(card, description);
      card.addView(new View(ui.context), new LinearLayout.LayoutParams(1, 0, 1));
      price = ui.text("", 17, Ui.TILE_INK, true);
      ui.full(card, price);
    }
  }
}
