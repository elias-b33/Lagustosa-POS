package se.restaurant.nativepos;

import java.util.UUID;
import org.json.JSONObject;

/** One durable unresolved write per installation. Never silently replace or expire it. */
public final class CommandJournal {
  public interface Storage {
    String read();

    boolean write(String value);
  }

  private final Storage storage;

  public CommandJournal(Storage storage) {
    this.storage = storage;
  }

  public Pending load() {
    String value = storage.read();
    if (value == null || value.isEmpty()) return null;
    JSONObject o = Json.object(value);
    if (o.optInt("format") != 1
        || !o.has("body")
        || !o.has("owner")
        || !o.has("origin")
        || !o.has("path"))
      throw new IllegalStateException(
          "Ett sparat försök kan inte läsas. Be ansvarig kontrollera enheten; radera inte appens"
              + " data.");
    return new Pending(o);
  }

  public Pending begin(
      String origin,
      String owner,
      String round,
      String path,
      String method,
      JSONObject input,
      String label) {
    if (load() != null)
      throw new IllegalStateException("Slutför det sparade försöket innan en ny ändring görs.");
    if (!path.matches("/[a-zA-Z0-9_/-]+")
        || path.contains("..")
        || !(method.equals("POST") || method.equals("PUT")))
      throw new IllegalArgumentException("Ogiltig ändring");
    JSONObject body = Json.copy(input);
    if (keyed(path) && !body.has("key")) Json.put(body, "key", UUID.randomUUID().toString());
    JSONObject o =
        Json.obj(
            "format",
            1,
            "origin",
            origin,
            "owner",
            owner,
            "round",
            round,
            "path",
            path,
            "method",
            method,
            "body",
            body,
            "label",
            label,
            "created",
            System.currentTimeMillis(),
            "rejected",
            false);
    Pending pending = new Pending(o);
    save(pending);
    return pending;
  }

  public void save(Pending p) {
    if (!storage.write(p.json.toString()))
      throw new IllegalStateException(
          "Försöket kunde inte sparas på enheten. Ingen ny ändring skickas.");
  }

  public void clear() {
    if (!storage.write(""))
      throw new IllegalStateException(
          "Det sparade försöket kunde inte kvitteras. Återuppta samma försök.");
  }

  public static boolean keyed(String path) {
    return path.equals("/tabs")
        || path.equals("/business-days")
        || path.equals("/cash-movements")
        || path.matches("/tabs/[^/]+/(commands|payments)")
        || path.matches("/payments/[^/]+/refunds")
        || path.matches("/business-days/[^/]+/close");
  }

  public static final class Pending {
    public final JSONObject json, body;
    public final String origin, owner, round, path, method, label;

    Pending(JSONObject o) {
      json = o;
      body = Json.child(o, "body");
      origin = o.optString("origin");
      owner = o.optString("owner");
      round = o.optString("round");
      path = o.optString("path");
      method = o.optString("method");
      label = o.optString("label");
    }

    public boolean matches(String origin, Snapshot snapshot) {
      return this.origin.equals(origin)
          && owner.equals(snapshot.owner)
          && round.equals(snapshot.round);
    }

    public boolean retryable() {
      return keyed(path)
          || method.equals("PUT") && !path.startsWith("/devices/")
          || path.matches(
              "/(payments/[^/]+/(check|cancel)|receipts/[^/]+/verify|tickets/[^/]+/status)");
    }

    public boolean rejected() {
      return json.optBoolean("rejected");
    }
  }
}
