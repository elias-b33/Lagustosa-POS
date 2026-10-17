package se.restaurant.nativepos;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.*;
import java.util.List;

public final class Ui {
  public static final int CANVAS = Color.rgb(23, 26, 33),
      PAPER = Color.rgb(34, 39, 49),
      RAISED = Color.rgb(44, 51, 63),
      INK = Color.rgb(241, 243, 248),
      MUTED = Color.rgb(167, 176, 191),
      LINE = Color.rgb(58, 67, 81),
      ACCENT = Color.rgb(255, 174, 97),
      ON_ACCENT = Color.rgb(37, 25, 15),
      GREEN = Color.rgb(152, 215, 172),
      WARNING = Color.rgb(235, 195, 116),
      DANGER = Color.rgb(255, 154, 154),
      TILE_INK = Color.rgb(23, 33, 43);
  public static final int[] TONES = {
    0xff7bc5d8, 0xffed9299, 0xffb9a2de, 0xffeacb75, 0xffa0ce94, 0xff9bb8ed
  };
  public final Context context;
  public int accent = ACCENT;

  public Ui(Context context) {
    this.context = context;
  }

  public int dp(float value) {
    return Math.round(value * context.getResources().getDisplayMetrics().density);
  }

  public GradientDrawable shape(int color, int radius, boolean border) {
    GradientDrawable d = new GradientDrawable();
    d.setColor(color);
    d.setCornerRadius(dp(radius));
    if (border) d.setStroke(dp(1), LINE);
    return d;
  }

  public LinearLayout column() {
    LinearLayout v = new LinearLayout(context);
    v.setOrientation(LinearLayout.VERTICAL);
    return v;
  }

  public LinearLayout row() {
    LinearLayout v = new LinearLayout(context);
    v.setOrientation(LinearLayout.HORIZONTAL);
    v.setGravity(Gravity.CENTER_VERTICAL);
    return v;
  }

  public void pad(View v, int n) {
    v.setPadding(dp(n), dp(n), dp(n), dp(n));
  }

  public LinearLayout.LayoutParams lp(int width, int height) {
    return new LinearLayout.LayoutParams(
        width < 0 ? width : dp(width), height < 0 ? height : dp(height));
  }

  public void full(LinearLayout parent, View child) {
    parent.addView(child, lp(-1, -2));
  }

  public void weight(LinearLayout parent, View child) {
    parent.addView(
        child,
        new LinearLayout.LayoutParams(
            parent.getOrientation() == LinearLayout.VERTICAL ? -1 : 0,
            parent.getOrientation() == LinearLayout.VERTICAL ? 0 : -1,
            1));
  }

  public TextView text(String value, int size, int color, boolean bold) {
    TextView v = new TextView(context);
    v.setText(value);
    v.setTextSize(size);
    v.setTextColor(color);
    v.setFontFeatureSettings("tnum");
    if (bold) v.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    return v;
  }

  public TextView label(String value) {
    TextView v = text(value, 13, MUTED, false);
    v.setPadding(0, dp(10), 0, dp(5));
    return v;
  }

  public TextView button(String text, boolean primary, Runnable action) {
    TextView b = text(text, 14, primary ? ON_ACCENT : INK, true);
    b.setGravity(Gravity.CENTER);
    b.setMinHeight(dp(48));
    b.setPadding(dp(12), dp(8), dp(12), dp(8));
    b.setFocusable(true);
    b.setClickable(true);
    b.setBackground(
        new RippleDrawable(
            ColorStateList.valueOf(0x26ffffff), shape(primary ? accent : RAISED, 6, false), null));
    b.setOnClickListener(v -> action.run());
    b.setContentDescription(text);
    return b;
  }

  public void enable(View view, boolean enabled) {
    view.setEnabled(enabled);
    view.setAlpha(enabled ? 1f : .45f);
  }

  public EditText input(String value, String hint, int kind) {
    EditText v = new EditText(context);
    v.setText(value);
    v.setHint(hint);
    v.setTextColor(INK);
    v.setHintTextColor(MUTED);
    v.setTextSize(16);
    v.setSingleLine(true);
    v.setInputType(kind);
    v.setMinHeight(dp(48));
    pad(v, 10);
    v.setBackground(shape(PAPER, 6, true));
    v.setContentDescription(hint);
    return v;
  }

  public EditText field(LinearLayout parent, String label, String value, int kind) {
    full(parent, label(label));
    EditText input = input(value, label, kind);
    full(parent, input);
    return input;
  }

  public EditText field(LinearLayout parent, String label, String value) {
    return field(parent, label, value, InputType.TYPE_CLASS_TEXT);
  }

  public void showField(View field, boolean visible) {
    int visibility = visible ? View.VISIBLE : View.GONE;
    field.setVisibility(visibility);
    ViewGroup parent = (ViewGroup) field.getParent();
    int index = parent.indexOfChild(field);
    if (index > 0) parent.getChildAt(index - 1).setVisibility(visibility);
  }

  public Spinner select(LinearLayout parent, String label, List<String> options, int selected) {
    if (!label.isEmpty()) full(parent, label(label));
    Spinner spinner = new Spinner(context);
    ArrayAdapter<String> adapter =
        new ArrayAdapter<>(context, android.R.layout.simple_spinner_item, options);
    adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
    spinner.setAdapter(adapter);
    spinner.setSelection(Math.max(0, selected));
    spinner.setMinimumHeight(dp(48));
    spinner.setBackground(shape(PAPER, 6, true));
    spinner.setContentDescription(label);
    full(parent, spinner);
    return spinner;
  }

  public CheckBox check(LinearLayout parent, String label, boolean checked) {
    CheckBox box = new CheckBox(context);
    box.setText(label);
    box.setTextColor(INK);
    box.setChecked(checked);
    box.setMinHeight(dp(48));
    full(parent, box);
    return box;
  }

  public ScrollView scroll(View child) {
    ScrollView scroll = new ScrollView(context);
    scroll.setFillViewport(true);
    scroll.addView(child);
    return scroll;
  }

  public void gap(LinearLayout parent, int size) {
    parent.addView(new View(context), lp(1, size));
  }

  public static String selected(Spinner spinner, String[] values) {
    return values[Math.max(0, spinner.getSelectedItemPosition())];
  }

  public static int index(String[] values, String value) {
    for (int i = 0; i < values.length; i++) if (values[i].equals(value)) return i;
    return 0;
  }
}
