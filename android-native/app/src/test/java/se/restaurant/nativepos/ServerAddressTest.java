package se.restaurant.nativepos;

import static org.junit.Assert.*;

import org.junit.Test;

public class ServerAddressTest {
  @Test
  public void normalizesOnlyAnOrigin() {
    assertEquals(
        "https://pos.example", ServerAddress.normalize(" https://POS.example:443/ ", false));
  }

  @Test
  public void debugHttpOnlyOnLiteralPrivateOrLoopbackAddresses() {
    for (String host : new String[] {"127.0.0.1", "10.0.2.2", "192.168.1.109", "172.16.0.1"})
      assertEquals("http://" + host, ServerAddress.normalize("http://" + host, true));
    for (String host : new String[] {"example.com", "172.32.0.1", "8.8.8.8", "10.256.1.1"})
      assertThrows(
          IllegalArgumentException.class, () -> ServerAddress.normalize("http://" + host, true));
  }

  @Test
  public void releaseRequiresTlsAndRejectsCredentialsPathsAndRedirectParameters() {
    for (String value :
        new String[] {
          "http://10.0.2.2",
          "https://u:p@host",
          "https://host/a",
          "https://host?next=evil",
          "https://host#frag",
          "https://host:99999",
          "https://host:0"
        })
      assertThrows(
          value, IllegalArgumentException.class, () -> ServerAddress.normalize(value, false));
  }

  @Test
  public void exportsAreExplicitlyAllowlisted() {
    assertTrue(ServerAddress.exportPath("/business-days/day-1/register-reports.json"));
    assertTrue(ServerAddress.exportPath("/journal.xml"));
    for (String path :
        new String[] {
          null,
          "/auth/login",
          "/business-days/../report.csv",
          "/business-days/%2e%2e/report.csv",
          "/journal.json?next=evil"
        }) assertFalse(ServerAddress.exportPath(path));
  }
}
