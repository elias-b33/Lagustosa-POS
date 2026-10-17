package se.restaurant.nativepos;

import android.content.SharedPreferences;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.JSONObject;

/** No WebView, browser cookie jar, redirects, TLS bypass, or payment SDK. */
public final class ApiClient {
  public static final class Failure extends IOException {
    public final int status;
    public final String code;

    Failure(int status, String code, String message) {
      super(message);
      this.status = status;
      this.code = code;
    }

    public boolean uncertain() {
      return status == 0 || status >= 500;
    }
  }

  public final String origin;
  private final SharedPreferences sessions;
  private volatile String cookie;

  public ApiClient(String origin, SharedPreferences sessions) {
    this.origin = origin;
    this.sessions = sessions;
    cookie = sessions.getString(origin, "");
  }

  public boolean hasSession() {
    return !cookie.isEmpty();
  }

  public void clearSession() {
    cookie = "";
    sessions.edit().remove(origin).commit();
  }

  public HttpURLConnection connection(String path, int timeout) throws IOException {
    if (!path.startsWith("/")
        || path.contains("..")
        || path.contains("\\")
        || path.indexOf('\n') >= 0) throw new IOException("Ogiltig API-adress");
    HttpURLConnection c = (HttpURLConnection) new URL(origin + "/api/v1" + path).openConnection();
    c.setInstanceFollowRedirects(false);
    c.setConnectTimeout(5000);
    c.setReadTimeout(timeout);
    c.setRequestProperty("Accept", "application/json");
    c.setRequestProperty("Cache-Control", "no-store");
    if (!cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
    return c;
  }

  public JSONObject get(String path) throws IOException {
    return parse(request(path, null, "GET"));
  }

  public JSONObject post(String path, JSONObject body) throws IOException {
    return parse(request(path, body, "POST"));
  }

  public static JSONObject parse(String text) throws Failure {
    try {
      return Json.object(text);
    } catch (IllegalArgumentException e) {
      throw new Failure(
          0, "RESPONSE_UNCERTAIN", "Svaret kunde inte läsas. Återuppta det sparade försöket.");
    }
  }

  public String request(String path, JSONObject body, String method) throws IOException {
    HttpURLConnection c = connection(path, 15000);
    try {
      c.setRequestMethod(method);
      if (body != null) {
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        c.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream out = c.getOutputStream()) {
          out.write(bytes);
        }
      }
      int status = c.getResponseCode();
      String text = read(status >= 400 ? c.getErrorStream() : c.getInputStream());
      if (status >= 200 && status < 300) {
        for (Map.Entry<String, List<String>> header : c.getHeaderFields().entrySet())
          if ("Set-Cookie".equalsIgnoreCase(header.getKey())) {
            for (String value : header.getValue())
              for (HttpCookie item : HttpCookie.parse(value)) {
                cookie = item.getMaxAge() == 0 ? "" : item.getName() + "=" + item.getValue();
                if (!sessions.edit().putString(origin, cookie).commit())
                  throw new Failure(
                      0, "SESSION_STORAGE", "Inloggningen kunde inte sparas på enheten.");
              }
          }
        return text;
      }
      JSONObject error;
      try {
        error = Json.object(text);
      } catch (RuntimeException e) {
        error = new JSONObject();
      }
      throw new Failure(
          status,
          error.optString("code", "SERVER_ERROR"),
          error.optString("message", "Kassaservern kunde inte slutföra anropet (" + status + ")."));
    } catch (Failure e) {
      throw e;
    } catch (IOException e) {
      throw new Failure(
          0,
          "NETWORK",
          "Kontakten med kassaservern bröts. Det sparade försöket kan återupptas när anslutningen"
              + " är tillbaka.");
    } finally {
      c.disconnect();
    }
  }

  private static String read(InputStream stream) throws IOException {
    if (stream == null) return "";
    try (InputStream in = stream;
        ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[8192];
      int n;
      while ((n = in.read(buffer)) >= 0) {
        if (out.size() + n > 32 * 1024 * 1024) throw new IOException("Svaret är för stort");
        out.write(buffer, 0, n);
      }
      return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
  }
}
