package se.restaurant.nativepos;

import android.app.*;
import android.content.*;
import android.content.res.Configuration;
import android.net.*;
import android.os.*;
import android.text.InputType;
import android.view.*;
import android.widget.*;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.JSONObject;

public final class MainActivity extends Activity implements PosController.Listener {
  public interface Screen {
    View view();

    void bind(Snapshot data);
  }

  public PosController controller;
  public Ui ui;
  public Forms forms;
  public FrameMonitor frames;
  public String selectedTab = "", activeView = "home";
  private LinearLayout root, content, notice;
  private TextView connection, message, pendingButton;
  private Screen screen;
  private String structure = "";
  private AlertDialog dialog;
  private boolean forceSetup, measuring;
  private String exportText;
  private ConnectivityManager connectivity;
  private ConnectivityManager.NetworkCallback network;

  @Override
  public void onCreate(Bundle saved) {
    super.onCreate(saved);
    controller = ((PosApplication) getApplication()).controller();
    ui = new Ui(this);
    forms = new Forms(this);
    applyAccent();
    getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    getWindow()
        .setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    if (BuildConfig.TEST_BUILD) getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    // Cold launches start with no bill selected. Rotation retains the current workspace.
    selectedTab = saved == null ? "" : saved.getString("tab", "");
    activeView = saved == null ? "home" : saved.getString("view", "home");
    frames = new FrameMonitor(getWindow());
    if (BuildConfig.DEBUG)
      StrictMode.setThreadPolicy(
          new StrictMode.ThreadPolicy.Builder().detectNetwork().penaltyLog().build());
    controller.attach(this);
    changed();
    connectivity = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
    network =
        new ConnectivityManager.NetworkCallback() {
          @Override
          public void onLost(Network n) {
            runOnUiThread(
                () -> {
                  controller.online = false;
                  changed();
                  controller.refresh();
                });
          }

          @Override
          public void onAvailable(Network n) {
            runOnUiThread(() -> controller.refresh());
          }
        };
    connectivity.registerDefaultNetworkCallback(network);
  }

  private void applyAccent() {
    String color = controller.preferences.getString("accent", "orange");
    ui.accent =
        color.equals("teal")
            ? 0xff89d6ca
            : color.equals("blue") ? 0xff9ebfff : color.equals("slate") ? 0xffbfc9da : Ui.ACCENT;
  }

  @Override
  protected void onResume() {
    super.onResume();
    controller.attach(this);
    controller.foreground(true);
    awake();
  }

  @Override
  protected void onPause() {
    if (measuring && BuildConfig.TEST_BUILD) {
      JSONObject report = frames.report();
      if (screen instanceof PosScreen) ((PosScreen) screen).addDiagnostics(report);
      String text = report.toString();
      java.io.File directory = getExternalFilesDir("diagnostics");
      if (directory != null)
        new Thread(
                () -> {
                  try (OutputStream out =
                      new java.io.FileOutputStream(new java.io.File(directory, "frames.json"))) {
                    out.write(text.getBytes(StandardCharsets.UTF_8));
                  } catch (java.io.IOException ignored) {
                  }
                },
                "native-diagnostics")
            .start();
    }
    controller.foreground(false);
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    controller.detach(this);
    if (network != null) connectivity.unregisterNetworkCallback(network);
    frames.close();
    super.onDestroy();
  }

  @Override
  protected void onSaveInstanceState(Bundle state) {
    state.putString("view", activeView);
    state.putString("tab", selectedTab);
    super.onSaveInstanceState(state);
  }

  @Override
  public void onConfigurationChanged(Configuration c) {
    super.onConfigurationChanged(c);
    rebuild();
  }

  public void awake() {
    if (controller.preferences.getBoolean("awake", true))
      getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
  }

  public boolean counter() {
    String layout = controller.preferences.getString("layout", "auto");
    int width = getResources().getConfiguration().screenWidthDp;
    return width >= 600 && (layout.equals("counter") || layout.equals("auto") && width >= 720);
  }

  public void rebuild() {
    structure = "";
    screen = null;
    applyAccent();
    changed();
  }

  @Override
  public void changed() {
    if (isFinishing()) return;
    Snapshot data = controller.snapshot;
    if (forceSetup || controller.origin().isEmpty()) {
      if (!structure.equals("setup")) buildSetup();
      return;
    }
    if (data == null) {
      String key = "login:" + controller.staff.toString();
      if (!structure.equals(key)) buildLogin(key);
      if (message != null)
        message.setText(controller.checking ? "Ansluter till kassaservern…" : controller.error);
      return;
    }
    if (data.stationOnly())
      activeView =
          !data.deviceStation.isEmpty()
              ? data.deviceStation
              : data.role.equals("bar") ? "bar" : "kitchen";
    if ((activeView.equals("reports") || activeView.equals("prints")) && !data.manager())
      activeView = "home";
    if (activeView.equals("settings") && !data.role.equals("admin")) activeView = "home";
    String key = "shell:" + counter() + ":" + activeView + ":" + data.owner;
    if (!key.equals(structure)) buildShell(key);
    connection.setText(
        controller.busy ? "Arbetar…" : controller.online ? "● Ansluten" : "● Ingen kontakt");
    connection.setTextColor(controller.online ? Ui.GREEN : Ui.DANGER);
    String warning = controller.error;
    if (!controller.online && warning.isEmpty())
      warning = "Kontakt med kassaservern saknas. Nya registreringar är låsta.";
    CommandJournal.Pending p = controller.pending;
    if (p != null)
      warning =
          "Sparat försök: "
              + p.label
              + ". "
              + (p.matches(controller.origin(), data)
                  ? (p.rejected()
                      ? "Servern har avvisat försöket."
                      : "Utfallet måste kontrolleras innan en ny ändring görs.")
                  : "Använd samma inloggning, server och testomgång som tidigare.")
              + (controller.error.isEmpty() ? "" : "\n" + controller.error);
    message.setText(warning);
    notice.setVisibility(warning.isEmpty() ? View.GONE : View.VISIBLE);
    pendingButton.setText(
        p == null
            ? "Kontrollera anslutning"
            : p.rejected()
                ? "Avsluta avvisat försök"
                : p.retryable() ? "Återuppta samma försök" : "Bekräfta efter kontroll");
    ui.enable(pendingButton, !controller.busy && (p == null || controller.online));
    if (screen != null) screen.bind(data);
  }

  private void base() {
    root = ui.column();
    root.setBackgroundColor(Ui.CANVAS);
    root.setFitsSystemWindows(true);
    setContentView(root);
    TextView test = ui.text("TEST — inga riktiga betalningar", 11, Ui.WARNING, true);
    test.setGravity(Gravity.CENTER);
    test.setBackgroundColor(0xff372e21);
    root.addView(test, ui.lp(-1, 24));
  }

  private void buildSetup() {
    structure = "setup";
    base();
    LinearLayout form = ui.column();
    ui.pad(form, 24);
    ui.full(form, ui.text("Restaurangkassa", 30, Ui.INK, true));
    ui.full(form, ui.label("Anslut till restaurangens kassaserver."));
    EditText server =
        ui.field(
            form,
            "Kassaserver",
            controller.origin(),
            InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    server.setHint("https://kassa.example:4173");
    EditText device =
        ui.field(form, "Enhetskod", controller.preferences.getString("device", "KASSA-TEST"));
    Spinner layout =
        ui.select(
            form,
            "Arbetsyta",
            Arrays.asList("Automatisk", "Handkassa", "Huvudkassa"),
            Ui.index(
                new String[] {"auto", "handheld", "counter"},
                controller.preferences.getString("layout", "auto")));
    CheckBox awake =
        ui.check(
            form,
            "Håll skärmen vaken under arbetet",
            controller.preferences.getBoolean("awake", true));
    ui.gap(form, 20);
    ui.full(
        form,
        ui.button(
            "Anslut kassan",
            true,
            () -> {
              if (controller.busy) {
                toast("Vänta tills pågående anrop är klart.");
                return;
              }
              try {
                ServerAddress.normalize(server.getText().toString(), BuildConfig.TEST_BUILD);
              } catch (Exception e) {
                toast(e.getMessage());
                return;
              }
              controller
                  .preferences
                  .edit()
                  .putString(
                      "layout", Ui.selected(layout, new String[] {"auto", "handheld", "counter"}))
                  .putBoolean("awake", awake.isChecked())
                  .apply();
              forceSetup = false;
              structure = "";
              controller.configure(server.getText().toString(), device.getText().toString());
              awake();
            }));
    if (!controller.origin().isEmpty()) {
      ui.gap(form, 8);
      ui.full(
          form,
          ui.button(
              "Tillbaka",
              false,
              () -> {
                forceSetup = false;
                rebuild();
              }));
    }
    ui.weight(root, ui.scroll(form));
  }

  private void buildLogin(String key) {
    structure = key;
    base();
    LinearLayout form = ui.column();
    ui.pad(form, 24);
    ui.full(form, ui.text("Redo för service", 30, Ui.INK, true));
    ui.full(form, ui.label("Välj personal och ange din PIN-kod."));
    if (controller.staff.isEmpty()) {
      message = ui.label("Hämtar personal…");
      ui.full(form, message);
      ui.full(form, ui.button("Försök igen", false, controller::connect));
      ui.full(
          form,
          ui.button(
              "Anslutning och enhet",
              false,
              () -> {
                forceSetup = true;
                rebuild();
              }));
      ui.weight(root, ui.scroll(form));
      return;
    }
    List<String> names = new ArrayList<>();
    for (JSONObject person : controller.staff) names.add(person.optString("name"));
    if (names.isEmpty()) names.add("Hämtar personal…");
    Spinner staff = ui.select(form, "Personal", names, 0);
    EditText pin =
        ui.field(
            form,
            "PIN-kod",
            "",
            InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
    pin.setShowSoftInputOnFocus(false);
    GridLayout keypad = new GridLayout(this);
    keypad.setColumnCount(3);
    for (String digit :
        new String[] {"1", "2", "3", "4", "5", "6", "7", "8", "9", "Rensa", "0", "⌫"}) {
      TextView button =
          ui.button(
              digit,
              false,
              () -> {
                String value = pin.getText().toString();
                pin.setText(
                    digit.equals("Rensa")
                        ? ""
                        : digit.equals("⌫")
                            ? (value.isEmpty() ? "" : value.substring(0, value.length() - 1))
                            : value.length() < 8 ? value + digit : value);
              });
      GridLayout.LayoutParams p = new GridLayout.LayoutParams();
      p.width = 0;
      p.height = ui.dp(52);
      p.columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1f);
      p.setMargins(ui.dp(3), ui.dp(3), ui.dp(3), ui.dp(3));
      keypad.addView(button, p);
    }
    ui.gap(form, 12);
    ui.full(form, keypad);
    ui.gap(form, 12);
    ui.full(
        form,
        ui.button(
            "Börja servicen",
            true,
            () -> {
              if (staff.getSelectedItemPosition() >= controller.staff.size()) {
                controller.connect();
                return;
              }
              if (!pin.getText().toString().matches("[0-9]{4,8}")) {
                toast("Ange 4–8 siffror.");
                return;
              }
              controller.login(
                  Json.id(controller.staff.get(staff.getSelectedItemPosition())),
                  pin.getText().toString());
              pin.setText("");
            }));
    message = ui.label("");
    message.setTextColor(Ui.DANGER);
    ui.full(form, message);
    ui.full(
        form,
        ui.button(
            "Anslutning och enhet",
            false,
            () -> {
              forceSetup = true;
              rebuild();
            }));
    ui.weight(root, ui.scroll(form));
  }

  private void buildShell(String key) {
    structure = key;
    base();
    LinearLayout top = ui.row();
    ui.pad(top, 10);
    top.setBackgroundColor(Ui.PAPER);
    TextView brand = ui.text("Restaurangkassa", 18, Ui.INK, true);
    top.addView(brand, new LinearLayout.LayoutParams(0, -2, 1));
    connection = ui.text("", 11, Ui.GREEN, false);
    top.addView(connection, ui.lp(-2, -2));
    TextView more = ui.button("⋮", false, this::deviceMenu);
    top.addView(more, ui.lp(44, 48));
    root.addView(top, ui.lp(-1, 60));
    notice = ui.column();
    ui.pad(notice, 10);
    notice.setBackgroundColor(0xff372e21);
    message = ui.text("", 13, Ui.WARNING, false);
    message.setMaxLines(4);
    ui.full(notice, message);
    pendingButton =
        ui.button(
            "",
            false,
            () -> {
              if (controller.pending == null) controller.refresh();
              else if (controller.pending.rejected())
                confirm(
                    "Avsluta avvisat försök?",
                    "Servern har avvisat försöket. Kontrollera notan innan du gör en ny ändring.",
                    controller::acknowledgeRejected);
              else if (!controller.pending.retryable())
                confirm(
                    "Har du kontrollerat utfallet?",
                    "Kontrollera historiken och eventuell fysisk utskrift. Försöket skickas inte"
                        + " igen. Fortsätt först när du har fastställt vad som hände.",
                    controller::acknowledgeReviewed);
              else controller.retry();
            });
    ui.full(notice, pendingButton);
    ui.full(root, notice);
    LinearLayout workspace = ui.row();
    ui.weight(root, workspace);
    if (counter()) workspace.addView(navigation(true), ui.lp(100, -1));
    content = ui.column();
    workspace.addView(content, new LinearLayout.LayoutParams(0, -1, 1));
    screen = activeView.equals("home") ? new HomeScreen(this)
        : activeView.equals("tables") ? new TableMapScreen(this)
        : activeView.equals("pos") ? new PosScreen(this) : new WorkspaceScreen(this, activeView);
    content.addView(screen.view(), ui.lp(-1, -1));
    if (!counter()) root.addView(navigation(false), ui.lp(-1, 58));
  }

  private View navigation(boolean vertical) {
    LinearLayout nav = vertical ? ui.column() : ui.row();
    nav.setBackgroundColor(Ui.PAPER);
    List<String> ids =
        new ArrayList<>(
            Arrays.asList("home", "pos", "tables", "kitchen", "bar", "prints", "reports", "settings"));
    Snapshot s = controller.snapshot;
    if (s.stationOnly()) ids = new ArrayList<>(Collections.singletonList(activeView));
    if (!s.manager()) {
      ids.remove("prints");
      ids.remove("reports");
    }
    if (!s.role.equals("admin")) ids.remove("settings");
    for (String id : ids) {
      String label = title(id);
      TextView button = ui.button(label, false, () -> navigate(id));
      button.setTextSize(12);
      if (id.equals(activeView)) {
        button.setTextColor(ui.accent);
        button.setBackground(ui.shape(Ui.RAISED, 0, false));
      }
      if (vertical) nav.addView(button, ui.lp(-1, 64));
      else nav.addView(button, ui.lp(78, -1));
    }
    if (vertical) return ui.scroll(nav);
    HorizontalScrollView scroll = new HorizontalScrollView(this);
    scroll.setHorizontalScrollBarEnabled(false);
    scroll.addView(nav, new ViewGroup.LayoutParams(-2, -1));
    return scroll;
  }

  public static String title(String id) {
    switch (id) {
      case "home":
        return "Start";
      case "pos":
        return "Kassa";
      case "tables":
        return "Bordskarta";
      case "kitchen":
        return "Kök";
      case "bar":
        return "Bar";
      case "prints":
        return "Utskrifter";
      case "reports":
        return "Dagsöversikt";
      default:
        return "Inställningar";
    }
  }

  public void navigate(String view) {
    if (view.equals("home")) {
      if (controller.busy) {
        toast("Vänta tills ändringen är klar.");
        return;
      }
      selectedTab = "";
      controller.preferences.edit().remove("tab").apply();
    }
    activeView = view;
    controller.setScope(view.equals("home") || view.equals("pos") || view.equals("tables") ? "service" : "full");
    rebuild();
  }

  public void leaveTab() {
    // Keep the durable command journal and all server data; only clear UI selection.
    if (controller.busy) {
      toast("Vänta tills ändringen är klar, så att du kan kontrollera att den sparats.");
      return;
    }
    navigate("home");
  }

  public void openTable(JSONObject table) {
    Snapshot data = controller.snapshot;
    if (data == null) return;
    JSONObject current = TableLookup.byId(data.tables, Json.id(table));
    if (current == null || !current.optBoolean("active")) {
      toast("Bordet är inte tillgängligt längre.");
      return;
    }
    JSONObject open = TableLookup.openTab(data.tabs, Json.id(current));
    if (open != null) selectTab(Json.id(open));
    else if (controller.writable()) forms.newTab(current);
    else toast("Anslut till kassaservern innan du öppnar ett ledigt bord.");
  }

  public void selectTab(String id) {
    if (id.isEmpty()) {
      leaveTab();
      return;
    }
    selectedTab = id;
    controller.preferences.edit().putString("tab", id).apply();
    if (!activeView.equals("pos")) navigate("pos");
    else changed();
  }

  public JSONObject tab() {
    return controller.snapshot == null ? null : controller.snapshot.tab(selectedTab);
  }

  public void command(JSONObject tab, JSONObject body, String label) {
    if (tab == null) {
      toast("Välj en nota.");
      return;
    }
    Json.put(body, "version", tab.optInt("version"));
    write("/tabs/" + Json.id(tab) + "/commands", body, "POST", label);
  }

  public void write(String path, JSONObject body, String method, String label) {
    if (!controller.writable()) {
      toast("Kassan måste vara ansluten och tidigare försök slutförda.");
      return;
    }
    dismiss();
    controller.mutate(path, body, method, label);
  }

  @Override
  public void result(String path, JSONObject result) {
    if (path.equals("/tabs")) selectTab(Json.id(result));
    else if (path.endsWith("/payments")
        || path.endsWith("/refunds")
        || path.matches("/payments/[^/]+/(check|cancel)")) forms.paymentResult(result);
    else if (path.startsWith("/devices") && result.has("code"))
      textDialog(
          "Enhetskod",
          result.optString("code") + "\nSpara koden. Den ersätter enhetens tidigare kod.");
  }

  public void modal(String title, LinearLayout form, String positive, Runnable save) {
    dismiss();
    ui.pad(form, 16);
    ScrollView scroll = ui.scroll(form);
    AlertDialog.Builder builder =
        new AlertDialog.Builder(this)
            .setTitle(title)
            .setView(scroll)
            .setNegativeButton("Stäng", (d, w) -> {});
    if (positive != null) builder.setPositiveButton(positive, null);
    dialog = builder.create();
    dialog.setOnShowListener(
        d -> {
          if (positive != null)
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> safe(save));
          if (dialog.getWindow() != null) {
            Window window = dialog.getWindow();
            int width =
                Math.min(getResources().getDisplayMetrics().widthPixels - ui.dp(20), ui.dp(640));
            window.setBackgroundDrawable(ui.shape(Ui.PAPER, 10, true));
            window.setLayout(width, -2);
            window
                .getDecorView()
                .post(
                    () -> {
                      if (window.getDecorView().getHeight()
                          > getResources().getDisplayMetrics().heightPixels - ui.dp(72))
                        window.setLayout(
                            width, getResources().getDisplayMetrics().heightPixels - ui.dp(72));
                    });
          }
        });
    dialog.show();
  }

  public void dismiss() {
    if (dialog != null) {
      dialog.dismiss();
      dialog = null;
    }
  }

  public void textDialog(String title, String text) {
    LinearLayout form = ui.column();
    TextView value = ui.text(text, 14, Ui.INK, false);
    value.setTextIsSelectable(true);
    ui.full(form, value);
    modal(title, form, null, () -> {});
  }

  public void confirm(String title, String message, Runnable action) {
    new AlertDialog.Builder(this)
        .setTitle(title)
        .setMessage(message)
        .setNegativeButton("Tillbaka", null)
        .setPositiveButton("Fortsätt", (d, w) -> safe(action))
        .show();
  }

  public void choose(String title, String[] labels, java.util.function.IntConsumer choice) {
    new AlertDialog.Builder(this)
        .setTitle(title)
        .setItems(labels, (d, i) -> safe(() -> choice.accept(i)))
        .setNegativeButton("Stäng", null)
        .show();
  }

  public void safe(Runnable action) {
    try {
      action.run();
    } catch (IllegalArgumentException e) {
      toast(e.getMessage());
    }
  }

  public void toast(String message) {
    Toast.makeText(
            this, message == null ? "Åtgärden kunde inte slutföras." : message, Toast.LENGTH_LONG)
        .show();
  }

  private void deviceMenu() {
    choose(
        "Den här enheten",
        new String[] {
          "Anslutning och arbetsyta",
          "Mät prestanda",
          "Spara prestandamätning",
          "Logga ut",
          "Om appen och licenser"
        },
        i -> {
          if (i == 0) {
            forceSetup = true;
            rebuild();
          }
          if (i == 1) {
            frames.reset();
            measuring = true;
            toast("Mätningen nollställd. Prova sökning och rulla i menyn, spara sedan mätningen.");
          }
          if (i == 2)
            saveText("native-prestanda.json", frames.report().toString(), "application/json");
          if (i == 3) controller.logout();
          if (i == 4)
            new Thread(
                    () -> {
                      try (java.io.InputStream input = getAssets().open("THIRD_PARTY_NOTICES.txt");
                          java.io.InputStream license = getAssets().open("APACHE-2.0.txt")) {
                        String text = assetText(input) + "\n\n" + assetText(license);
                        runOnUiThread(
                            () ->
                                textDialog(
                                    "Restaurangkassa Native · " + BuildConfig.VERSION_NAME, text));
                      } catch (java.io.IOException e) {
                        runOnUiThread(() -> toast("Licensinformationen kunde inte öppnas."));
                      }
                    },
                    "native-licenses")
                .start();
        });
  }

  private String assetText(java.io.InputStream input) throws java.io.IOException {
    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
    byte[] buffer = new byte[4096];
    int n;
    while ((n = input.read(buffer)) != -1) out.write(buffer, 0, n);
    return out.toString("UTF-8");
  }

  public void saveText(String name, String text, String mime) {
    exportText = text;
    Intent intent =
        new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime)
            .putExtra(Intent.EXTRA_TITLE, name);
    startActivityForResult(intent, 91);
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request == 91
        && result == RESULT_OK
        && data != null
        && data.getData() != null
        && exportText != null) {
      Uri uri = data.getData();
      String text = exportText;
      exportText = null;
      new Thread(
              () -> {
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                  if (out == null) throw new java.io.IOException();
                  out.write(text.getBytes(StandardCharsets.UTF_8));
                  runOnUiThread(() -> toast("Filen är sparad."));
                } catch (Exception e) {
                  runOnUiThread(() -> toast("Filen kunde inte sparas."));
                }
              },
              "native-export")
          .start();
    }
  }

  @Override
  public void onBackPressed() {
    if (forceSetup) {
      forceSetup = false;
      rebuild();
      return;
    }
    if (screen instanceof HomeScreen && ((HomeScreen) screen).back()) return;
    if (screen instanceof PosScreen && ((PosScreen) screen).back()) return;
    if (!activeView.equals("home")
        && controller.snapshot != null
        && !controller.snapshot.stationOnly()) {
      leaveTab();
      return;
    }
    confirm(
        "Lämna kassan?",
        "Sparade beställningar ligger kvar på kassaservern. Osäkra försök bevaras på denna enhet.",
        () -> moveTaskToBack(true));
  }
}
