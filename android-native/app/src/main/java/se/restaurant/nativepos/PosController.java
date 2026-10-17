package se.restaurant.nativepos;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;

/** Network, JSON, totals and durable writes stay off the UI thread. One coalesced refresh. */
public final class PosController {
  public interface Listener {
    void changed();

    void result(String path, JSONObject result);
  }

  public final SharedPreferences preferences;
  private final SharedPreferences sessions;
  private final CommandJournal journal;
  private final ScheduledExecutorService io = Executors.newSingleThreadScheduledExecutor();
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService events = Executors.newSingleThreadExecutor();
  private final ExecutorService disconnects = Executors.newSingleThreadExecutor();
  private volatile HttpURLConnection stream;
  private volatile boolean foreground;
  private volatile int generation;
  private ScheduledFuture<?> heartbeat;
  private Listener listener;
  private ApiClient api;
  public volatile Snapshot snapshot;
  public volatile CommandJournal.Pending pending;
  public boolean online, busy, checking;
  public String error = "";
  public List<JSONObject> staff = Collections.emptyList();
  private String scope = "service";
  private boolean refreshQueued;

  public PosController(Context context) {
    preferences = context.getSharedPreferences("native-pos-settings", Context.MODE_PRIVATE);
    sessions = context.getSharedPreferences("native-pos-sessions", Context.MODE_PRIVATE);
    SharedPreferences writes =
        context.getSharedPreferences("native-pos-command", Context.MODE_PRIVATE);
    journal =
        new CommandJournal(
            new CommandJournal.Storage() {
              public String read() {
                return writes.getString("pending", "");
              }

              public boolean write(String value) {
                return writes.edit().putString("pending", value).commit();
              }
            });
    try {
      pending = journal.load();
    } catch (RuntimeException e) {
      error = e.getMessage();
    }
    String saved = preferences.getString("server", "");
    if (!saved.isEmpty()) api = new ApiClient(saved, sessions);
  }

  public String origin() {
    return api == null ? "" : api.origin;
  }

  public void attach(Listener listener) {
    this.listener = listener;
  }

  public void detach(Listener listener) {
    if (this.listener == listener) this.listener = null;
  }

  private void notifyUi() {
    if (listener != null) listener.changed();
  }

  public void message(String text) {
    error = text;
    notifyUi();
  }

  public void setScope(String value) {
    if (!scope.equals(value)) {
      scope = value;
      refresh();
    }
  }

  public void foreground(boolean value) {
    foreground = value;
    if (!value) {
      online = false;
      stopEvents();
      if (heartbeat != null) heartbeat.cancel(false);
      return;
    }
    if (api == null) return;
    if (snapshot == null) connect();
    else {
      refresh();
      startEvents();
    }
    if (heartbeat != null) heartbeat.cancel(false);
    heartbeat =
        io.scheduleWithFixedDelay(
            () -> {
              if (!foreground || api == null || snapshot == null) return;
              int epoch = generation;
              try {
                api.get("/ready");
                main.post(
                    () -> {
                      if (epoch == generation && foreground && !online) refresh();
                    });
              } catch (Exception e) {
                main.post(
                    () -> {
                      if (epoch == generation) {
                        online = false;
                        notifyUi();
                      }
                    });
              }
            },
            5,
            5,
            TimeUnit.SECONDS);
  }

  public void configure(String server, String device) {
    if (busy) {
      message("Vänta tills pågående anrop är klart.");
      return;
    }
    try {
      String normalized = ServerAddress.normalize(server, BuildConfig.DEBUG);
      if (device.trim().isEmpty()) throw new IllegalArgumentException("Ange enhetskoden.");
      if (pending != null && !pending.origin.equals(normalized))
        throw new IllegalArgumentException(
            "Slutför det sparade försöket innan servern ändras. En uppdaterad enhetskod kan anges"
                + " för samma server.");
      boolean changedDevice = !device.trim().equals(preferences.getString("device", ""));
      generation++;
      stopEvents();
      checking = false;
      refreshQueued = false;
      snapshot = null;
      staff = Collections.emptyList();
      online = false;
      preferences.edit().putString("server", normalized).putString("device", device.trim()).apply();
      api = new ApiClient(normalized, sessions);
      if (changedDevice) {
        ApiClient client = api;
        io.execute(client::clearSession);
      }
      connect();
    } catch (IllegalArgumentException e) {
      message(e.getMessage());
    }
  }

  public void connect() {
    if (api == null || checking) return;
    checking = true;
    error = "";
    notifyUi();
    int epoch = generation;
    ApiClient client = api;
    io.execute(
        () -> {
          try {
            JSONObject health = client.get("/health");
            if (!health.optBoolean("ok") || !health.optString("mode").equals("training"))
              throw new IllegalStateException("Denna version kräver kassaserverns träningsmiljö.");
            List<JSONObject> people =
                Json.list(new JSONArray(client.request("/auth/staff", null, "GET")));
            main.post(
                () -> {
                  if (epoch != generation) return;
                  checking = false;
                  staff = people;
                  notifyUi();
                  if (client.hasSession()) refresh();
                });
          } catch (Exception e) {
            main.post(
                () -> {
                  if (epoch != generation) return;
                  checking = false;
                  error = e.getMessage();
                  notifyUi();
                });
          }
        });
  }

  public void login(String staffId, String pin) {
    if (busy || api == null) return;
    busy = true;
    error = "";
    notifyUi();
    int epoch = generation;
    JSONObject input =
        Json.obj(
            "staffId",
            staffId,
            "pin",
            pin,
            "deviceCode",
            preferences.getString("device", "KASSA-TEST"));
    io.execute(
        () -> {
          try {
            api.post("/auth/login", input);
            main.post(
                () -> {
                  if (epoch == generation) {
                    busy = false;
                    refresh();
                    startEvents();
                  }
                });
          } catch (Exception e) {
            main.post(
                () -> {
                  if (epoch == generation) {
                    busy = false;
                    error = e.getMessage();
                    notifyUi();
                  }
                });
          }
        });
  }

  public void logout() {
    if (busy) {
      message("Vänta tills pågående anrop är klart.");
      return;
    }
    busy = true;
    notifyUi();
    io.execute(
        () -> {
          try {
            api.post("/auth/logout", new JSONObject());
            api.clearSession();
            main.post(
                () -> {
                  generation++;
                  stopEvents();
                  snapshot = null;
                  online = false;
                  busy = false;
                  notifyUi();
                });
          } catch (Exception e) {
            main.post(
                () -> {
                  busy = false;
                  message(e.getMessage());
                });
          }
        });
  }

  public void refresh() {
    if (api == null || !foreground || refreshQueued) return;
    refreshQueued = true;
    int epoch = generation;
    String requested = scope;
    ApiClient client = api;
    io.execute(
        () -> {
          try {
            JSONObject raw = client.get("/bootstrap?scope=" + requested);
            if (!raw.optString("mode").equals("training"))
              throw new IllegalStateException("Native-testappen får endast använda träningsdata.");
            Snapshot value = new Snapshot(raw, snapshot);
            main.post(
                () -> {
                  if (epoch != generation) return;
                  refreshQueued = false;
                  if (!foreground) return;
                  snapshot = value;
                  online = true;
                  checking = false;
                  notifyUi();
                  startEvents();
                  if (!requested.equals(scope)) refresh();
                });
          } catch (Exception e) {
            main.post(
                () -> {
                  if (epoch != generation) return;
                  refreshQueued = false;
                  online = false;
                  if (e instanceof ApiClient.Failure && ((ApiClient.Failure) e).status == 401) {
                    snapshot = null;
                    stopEvents();
                  } else error = e.getMessage();
                  notifyUi();
                });
          }
        });
  }

  public void mutate(String path, JSONObject body, String method, String label) {
    if (busy || !online || !foreground || snapshot == null) {
      message("Vänta tills kassan är ansluten.");
      return;
    }
    if (pending != null) {
      message("Ett tidigare försök behöver slutföras först.");
      return;
    }
    busy = true;
    error = "";
    notifyUi();
    Snapshot who = snapshot;
    io.execute(
        () -> {
          try {
            pending = journal.begin(api.origin, who.owner, who.round, path, method, body, label);
            submit(pending);
          } catch (Exception e) {
            failed(e);
          }
        });
  }

  public void retry() {
    if (busy || !online || !foreground || snapshot == null || pending == null) return;
    if (!pending.matches(origin(), snapshot)) {
      message(
          "Logga in på ursprunglig server med samma personal och enhet. Försöket får inte flyttas"
              + " mellan testomgångar.");
      return;
    }
    if (!pending.retryable()) {
      message(
          "Åtgärden kan inte upprepas säkert. Kontrollera utfallet i historiken eller på skrivaren"
              + " först.");
      return;
    }
    busy = true;
    error = "";
    notifyUi();
    io.execute(
        () -> {
          try {
            submit(pending);
          } catch (Exception e) {
            failed(e);
          }
        });
  }

  private void submit(CommandJournal.Pending attempt) throws Exception {
    Json.put(attempt.json, "rejected", false);
    journal.save(attempt);
    JSONObject result;
    try {
      result = ApiClient.parse(api.request(attempt.path, attempt.body, attempt.method));
    } catch (ApiClient.Failure e) {
      if (e.code.equals("VERSION_CONFLICT") && attempt.path.matches("/tabs/[^/]+/commands")) {
        JSONObject latest =
            api.get(attempt.path.substring(0, attempt.path.length() - "/commands".length()));
        Json.put(attempt.body, "version", latest.optInt("version"));
        journal.save(attempt);
        result = ApiClient.parse(api.request(attempt.path, attempt.body, attempt.method));
      } else throw e;
    }
    journal.clear();
    pending = null;
    JSONObject answer = result;
    main.post(
        () -> {
          busy = false;
          error = "";
          refresh();
          notifyUi();
          if (listener != null) listener.result(attempt.path, answer);
        });
  }

  private void failed(Exception e) {
    if (pending != null && e instanceof ApiClient.Failure) {
      ApiClient.Failure f = (ApiClient.Failure) e;
      if (f.status >= 400 && f.status < 500 && f.status != 401 && !f.code.equals("KEY_REUSED")) {
        Json.put(pending.json, "rejected", true);
        try {
          journal.save(pending);
        } catch (Exception storage) {
          e = storage;
        }
      }
    }
    String message = e.getMessage();
    boolean network = e instanceof ApiClient.Failure && ((ApiClient.Failure) e).uncertain();
    main.post(
        () -> {
          busy = false;
          if (network) online = false;
          error = message;
          notifyUi();
          refresh();
        });
  }

  public void acknowledgeRejected() {
    if (busy
        || pending == null
        || !pending.rejected()
        || snapshot == null
        || !pending.matches(origin(), snapshot)) return;
    busy = true;
    notifyUi();
    io.execute(
        () -> {
          try {
            journal.clear();
            pending = null;
            main.post(
                () -> {
                  busy = false;
                  error = "";
                  notifyUi();
                  refresh();
                });
          } catch (Exception e) {
            failed(e);
          }
        });
  }

  public void acknowledgeReviewed() {
    if (busy
        || pending == null
        || pending.retryable()
        || snapshot == null
        || !pending.matches(origin(), snapshot)) return;
    busy = true;
    notifyUi();
    io.execute(
        () -> {
          try {
            journal.clear();
            pending = null;
            main.post(
                () -> {
                  busy = false;
                  error = "";
                  notifyUi();
                  refresh();
                });
          } catch (Exception e) {
            failed(e);
          }
        });
  }

  public boolean writable() {
    return online && foreground && !busy && pending == null && snapshot != null;
  }

  public void read(String path, Consumer<String> callback) {
    if (api == null) return;
    int epoch = generation;
    io.execute(
        () -> {
          try {
            String value = api.request(path, null, "GET");
            main.post(
                () -> {
                  if (epoch == generation) callback.accept(value);
                });
          } catch (Exception e) {
            main.post(() -> message(e.getMessage()));
          }
        });
  }

  public void export(String path, Consumer<String> callback) {
    if (!ServerAddress.exportPath(path)) {
      message("Den här filen kan inte exporteras.");
      return;
    }
    read(path, callback);
  }

  private boolean streamStarting;

  private void startEvents() {
    if (!foreground || snapshot == null || stream != null || streamStarting) return;
    streamStarting = true;
    int epoch = generation;
    ApiClient client = api;
    events.execute(
        () -> {
          HttpURLConnection c = null;
          try {
            c = client.connection("/events", 25000);
            c.setRequestProperty("Accept", "text/event-stream");
            stream = c;
            if (c.getResponseCode() != 200)
              throw new IllegalStateException("Händelsekanalen kunde inte öppnas.");
            try (BufferedReader reader =
                new BufferedReader(
                    new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
              String line;
              while (foreground && epoch == generation && (line = reader.readLine()) != null) {
                if (line.startsWith("data:"))
                  main.post(
                      () -> {
                        if (epoch == generation && foreground) {
                          main.removeCallbacks(eventRefresh);
                          main.postDelayed(eventRefresh, 100);
                        }
                      });
              }
            }
          } catch (Exception ignored) {
            /* Readiness and the next snapshot determine availability, not SSE alone. */
          } finally {
            if (c != null) c.disconnect();
            if (stream == c) stream = null;
            main.post(
                () -> {
                  streamStarting = false;
                  if (foreground && snapshot != null)
                    main.postDelayed(
                        () -> {
                          refresh();
                          startEvents();
                        },
                        1500);
                });
          }
        });
  }

  private final Runnable eventRefresh = this::refresh;

  private void stopEvents() {
    HttpURLConnection old = stream;
    stream = null;
    if (old != null) disconnects.execute(old::disconnect);
    main.removeCallbacks(eventRefresh);
  }
}
