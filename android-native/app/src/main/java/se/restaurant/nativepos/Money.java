package se.restaurant.nativepos;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import org.json.JSONObject;

/** Integer öre throughout. Matches shared/money.ts; the server remains authoritative. */
public final class Money {
  private Money() {}

  public static long round(long numerator, long denominator) {
    if (numerator < 0 || denominator <= 0) throw new IllegalArgumentException("Ogiltigt belopp");
    return exact(
        BigInteger.valueOf(numerator)
            .multiply(BigInteger.valueOf(2))
            .add(BigInteger.valueOf(denominator))
            .divide(BigInteger.valueOf(denominator).multiply(BigInteger.valueOf(2))));
  }

  public static long[] distribute(long amount, long[] weights) {
    if (amount < 0) throw new IllegalArgumentException("Ogiltigt belopp");
    long total = 0;
    for (long w : weights) {
      if (w < 0) throw new IllegalArgumentException("Ogiltig vikt");
      total = Math.addExact(total, w);
    }
    long[] out = new long[weights.length];
    if (total == 0) {
      if (amount != 0) throw new IllegalArgumentException("Saknar belopp att fördela");
      return out;
    }
    BigInteger divisor = BigInteger.valueOf(total);
    List<Integer> order = new ArrayList<>();
    BigInteger[] remainder = new BigInteger[weights.length];
    long assigned = 0;
    for (int i = 0; i < weights.length; i++) {
      BigInteger[] parts =
          BigInteger.valueOf(amount)
              .multiply(BigInteger.valueOf(weights[i]))
              .divideAndRemainder(divisor);
      out[i] = exact(parts[0]);
      assigned += out[i];
      remainder[i] = parts[1];
      order.add(i);
    }
    order.sort(
        Comparator.<Integer, BigInteger>comparing(i -> remainder[i])
            .reversed()
            .thenComparingInt(i -> i));
    for (int i = 0; i < amount - assigned; i++) out[order.get(i)]++;
    return out;
  }

  public static long total(JSONObject tab) {
    long original = 0;
    for (JSONObject line : Json.list(tab, "lines"))
      if (!line.optString("status").equals("void"))
        original =
            Math.addExact(
                original,
                Math.multiplyExact(line.optLong("unitPriceOre"), line.optLong("quantity")));
    return original - round(Math.multiplyExact(original, tab.optLong("discountBps")), 10000);
  }

  public static Long parse(String value) {
    String normalized = value.trim().replace(',', '.');
    if (!normalized.matches("[0-9]+(\\.[0-9]{1,2})?")) return null;
    try {
      String[] parts = normalized.split("\\.");
      long n = Math.multiplyExact(Long.parseLong(parts[0]), 100);
      if (parts.length > 1) n += Long.parseLong(parts[1].length() == 1 ? parts[1] + "0" : parts[1]);
      return n <= 100000000 ? n : null;
    } catch (ArithmeticException | NumberFormatException e) {
      return null;
    }
  }

  public static String format(long ore) {
    String sign = ore < 0 ? "−" : "";
    long n = Math.abs(ore);
    String whole = Long.toString(n / 100);
    StringBuilder grouped = new StringBuilder();
    for (int i = 0; i < whole.length(); i++) {
      if (i > 0 && (whole.length() - i) % 3 == 0) grouped.append('\u00a0');
      grouped.append(whole.charAt(i));
    }
    return sign + grouped + (n % 100 == 0 ? "" : "," + (n % 100 < 10 ? "0" : "") + n % 100) + " kr";
  }

  public static String input(long ore) {
    return (ore / 100) + "," + (ore % 100 < 10 ? "0" : "") + (ore % 100);
  }

  private static long exact(BigInteger value) {
    if (value.bitLength() > 63) throw new ArithmeticException("Beloppet är för stort");
    return value.longValue();
  }
}
