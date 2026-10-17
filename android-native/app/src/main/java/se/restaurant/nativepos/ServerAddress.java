package se.restaurant.nativepos;

import java.net.URI;
import java.util.Locale;

public final class ServerAddress {
  private ServerAddress() {}

  public static String normalize(String input, boolean debug) {
    try {
      URI u = new URI(input.trim());
      String scheme = u.getScheme().toLowerCase(Locale.ROOT), host = u.getHost();
      if (host == null
          || u.getUserInfo() != null
          || u.getQuery() != null
          || u.getFragment() != null
          || !(u.getPath().isEmpty() || u.getPath().equals("/"))
          || u.getPort() == 0
          || u.getPort() > 65535) throw new IllegalArgumentException();
      if (!scheme.equals("https") && !(debug && scheme.equals("http") && local(host)))
        throw new IllegalArgumentException();
      int port = u.getPort();
      if (port == (scheme.equals("https") ? 443 : 80)) port = -1;
      return new URI(scheme, null, host.toLowerCase(Locale.ROOT), port, null, null, null)
          .toString();
    } catch (Exception e) {
      throw new IllegalArgumentException(
          debug
              ? "Ange en HTTPS-adress. Testappen tillåter även HTTP på lokala IP-adresser."
              : "Ange HTTPS och enbart serverns adress och port.");
    }
  }

  private static boolean local(String host) {
    if (host.equalsIgnoreCase("localhost") || host.equals("[::1]") || host.equals("::1"))
      return true;
    String[] p = host.split("\\.");
    if (p.length != 4) return false;
    int[] n = new int[4];
    for (int i = 0; i < 4; i++) {
      if (!p[i].matches("[0-9]{1,3}")) return false;
      n[i] = Integer.parseInt(p[i]);
      if (n[i] > 255) return false;
    }
    return n[0] == 10
        || n[0] == 127
        || n[0] == 192 && n[1] == 168
        || n[0] == 172 && n[1] >= 16 && n[1] <= 31;
  }

  public static boolean exportPath(String path) {
    return path != null
        && (path.equals("/journal.xml")
            || path.equals("/journal.json")
            || path.matches(
                "/business-days/[A-Za-z0-9_-]+/(report\\.csv|register-reports\\.json)"));
  }
}
