package se.restaurant.nativepos;

import static org.junit.Assert.*;

import java.util.Random;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class MoneyTest {
  @Test
  public void usesIntegerOreAndSwedishInput() {
    assertEquals(Long.valueOf(12345), Money.parse("123,45"));
    assertEquals(Long.valueOf(1000), Money.parse("10"));
    for (String bad : new String[] {"-1", "1,005", "NaN", "1e3", "1000000,01", "", "1.2.3"})
      assertNull(bad, Money.parse(bad));
    assertEquals("1\u00a0234,50 kr", Money.format(123450));
    assertEquals("0 kr", Money.format(0));
    assertEquals("−1,01 kr", Money.format(-101));
  }

  @Test
  public void roundsHalfUpWithoutFloatingPoint() {
    assertEquals(1, Money.round(1, 2));
    assertEquals(12, Money.round(12049, 1000));
    assertEquals(13, Money.round(12500, 1000));
  }

  @Test
  public void distributesRemainderDeterministically() {
    assertArrayEquals(new long[] {34, 33, 33}, Money.distribute(100, new long[] {1, 1, 1}));
    assertArrayEquals(new long[] {0, 1}, Money.distribute(1, new long[] {1, 2}));
  }

  @Test
  public void preservesEveryOreAcrossRandomSplits() {
    Random random = new Random(731);
    for (int n = 0; n < 2000; n++) {
      long amount = random.nextInt(100000000);
      long[] weights = new long[1 + random.nextInt(100)];
      for (int i = 0; i < weights.length; i++) weights[i] = 1 + random.nextInt(100000);
      long sum = 0;
      for (long value : Money.distribute(amount, weights)) {
        assertTrue(value >= 0);
        sum += value;
      }
      assertEquals(amount, sum);
    }
  }

  @Test
  public void excludesVoidedLinesBeforeDiscount() {
    JSONObject tab =
        Json.obj(
            "discountBps",
            1250,
            "lines",
            new JSONArray()
                .put(Json.obj("quantity", 3, "unitPriceOre", 1001, "status", "sent"))
                .put(Json.obj("quantity", 1, "unitPriceOre", 100000, "status", "void")));
    assertEquals(2628, Money.total(tab));
  }

  @Test
  public void refusesInvalidAmounts() {
    assertThrows(IllegalArgumentException.class, () -> Money.distribute(1, new long[] {0}));
    assertThrows(IllegalArgumentException.class, () -> Money.round(-1, 100));
    assertThrows(IllegalArgumentException.class, () -> Money.distribute(1, new long[] {-1}));
  }

  @Test
  public void rejectsOverflowWhenFractionIsAddedToWholeKronor() {
    for (String value : new String[] {"92233720368547758,08", "92233720368547758,99", "9223372036854775807"})
      assertNull(value, Money.parse(value));
    assertEquals(Long.valueOf(100000000), Money.parse("1000000,00"));
    assertNull(Money.parse("1000000,01"));
  }
}
