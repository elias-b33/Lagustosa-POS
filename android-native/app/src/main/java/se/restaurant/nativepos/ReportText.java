package se.restaurant.nativepos;

import org.json.JSONObject;

/** Displays the server's report values without reconstructing fiscal calculations. */
public final class ReportText {
  private ReportText() {}

  public static String register(JSONObject report) {
    StringBuilder text = new StringBuilder("ÖVNING · " + report.optString("kind") + "-rapport\n");
    text.append("Kassa: ")
        .append(report.optString("registerId", report.optString("legacyRegisterId")))
        .append("\n");
    text.append("Skapad: ").append(report.optString("generatedAt")).append("\n");
    if (!report.isNull("sequence"))
      text.append("Rapportnummer: ").append(report.optLong("sequence")).append("\n");
    JSONObject totals = Json.child(report, "training");
    money(text, totals, "salesOre", "Försäljning");
    money(text, totals, "refundsOre", "Returer");
    money(text, totals, "netOre", "Netto");
    money(text, totals, "tipsOre", "Dricks");
    money(text, totals, "discountsOre", "Rabatter");
    number(text, totals, "reductionsCount", "Rättelser, antal");
    money(text, totals, "reductionsOre", "Rättelser, belopp");
    number(text, totals, "receiptCopies", "Kvittokopior");
    money(text, totals, "receiptCopiesOre", "Kopierade kvitton, belopp");
    number(text, totals, "drawerOpenings", "Lådöppningar");
    number(text, totals, "openTabs", "Öppna notor");
    money(text, totals, "openTabAmountOre", "Öppna notor, belopp");
    number(text, totals, "unresolved", "Osäkra utfall");
    text.append("\nKontanthantering\n");
    money(text, totals, "floatOre", "Växelkassa");
    money(text, totals, "cashDepositsOre", "Insättningar");
    money(text, totals, "cashWithdrawalsOre", "Uttag");
    money(text, totals, "expectedCashOre", "Förväntat kontant");
    JSONObject receipts = Json.child(totals, "receiptCounts");
    text.append("\nKvitton\n");
    number(text, receipts, "sales", "Försäljning");
    number(text, receipts, "refunds", "Returer");
    number(text, receipts, "total", "Totalt");
    for (JSONObject method : Json.list(totals, "methods")) {
      text.append("\nBetalsätt: ").append(Forms.status(method.optString("method"))).append("\n");
      money(text, method, "salesOre", "Försäljning");
      money(text, method, "refundsOre", "Returer");
      money(text, method, "netOre", "Netto");
      money(text, method, "tipsOre", "Dricks");
    }
    for (JSONObject vat : Json.list(totals, "vat")) {
      text.append("\nMoms ").append(Money.input(vat.optLong("vatBps"))).append(" %\n");
      money(text, vat, "salesGrossOre", "Försäljning inklusive moms");
      money(text, vat, "salesVatOre", "Utgående moms");
      money(text, vat, "refundsGrossOre", "Returer inklusive moms");
      money(text, vat, "refundsVatOre", "Moms på returer");
      money(text, vat, "netGrossOre", "Netto inklusive moms");
      money(text, vat, "netVatOre", "Moms netto");
    }
    JSONObject counts = Json.child(totals, "articleCounts");
    text.append("\nArtikelantal\n");
    quantity(text, counts, "sold", "Sålda");
    quantity(text, counts, "refunded", "Returnerade");
    quantity(text, counts, "goodsSold", "Varor sålda");
    quantity(text, counts, "servicesSold", "Tjänster sålda");
    quantity(text, counts, "unclassifiedSold", "Oklassificerat sålt");
    quantity(text, counts, "goodsRefunded", "Varor returnerade");
    quantity(text, counts, "servicesRefunded", "Tjänster returnerade");
    quantity(text, counts, "unclassifiedRefunded", "Oklassificerat returnerat");
    quantity(text, counts, "saleAmountShares", "Försäljning som beloppsandelar");
    quantity(text, counts, "refundAmountShares", "Returer som beloppsandelar");
    number(text, counts, "missingSaleAllocations", "Saknad fördelning, försäljning");
    number(text, counts, "missingRefundAllocations", "Saknad fördelning, returer");
    for (JSONObject category : Json.list(totals, "categories")) {
      text.append("\nVarugrupp: ").append(category.optString("name")).append("\n");
      money(text, category, "salesOre", "Försäljning");
      money(text, category, "refundsOre", "Returer");
      money(text, category, "netOre", "Netto");
      quantity(text, category, "sold", "Antal sålda");
      quantity(text, category, "refunded", "Antal returnerade");
      quantity(text, category, "saleAmountShares", "Försäljning som beloppsandelar");
      quantity(text, category, "refundAmountShares", "Returer som beloppsandelar");
    }
    JSONObject cumulative = Json.child(Json.child(report, "cumulative"), "training");
    text.append("\nAckumulerade träningsbetalningar\n");
    money(text, cumulative, "salesOre", "Försäljning");
    money(text, cumulative, "refundsOre", "Returer");
    money(text, cumulative, "netOre", "Netto");
    JSONObject grand = Json.child(report, "grandTotals"),
        registered = Json.child(grand, "training");
    if (registered.length() > 0) {
      text.append("\nAckumulerade registrerade övningskvitton\n");
      money(text, registered, "salesOre", "Försäljning");
      money(text, registered, "returnsOre", "Returer");
      money(text, registered, "netOre", "Netto");
      number(text, registered, "saleReceipts", "Försäljningskvitton");
      number(text, registered, "returnReceipts", "Returkvitton");
      coverage(text, Json.child(grand, "coverage"));
    }
    coverage(text, Json.child(report, "coverage"));
    return text.toString();
  }

  private static void money(StringBuilder text, JSONObject object, String key, String label) {
    if (object.has(key))
      text.append(label).append(": ").append(Money.format(object.optLong(key))).append("\n");
  }

  private static void number(StringBuilder text, JSONObject object, String key, String label) {
    if (object.has(key)) text.append(label).append(": ").append(object.optLong(key)).append("\n");
  }

  private static void quantity(StringBuilder text, JSONObject object, String key, String label) {
    JSONObject value = object.optJSONObject(key);
    if (value != null)
      text.append(label)
          .append(": ")
          .append(value.optString("numerator", "0"))
          .append(
              value.optString("denominator", "1").equals("1")
                  ? ""
                  : "/" + value.optString("denominator"))
          .append("\n");
  }

  private static void coverage(StringBuilder text, JSONObject coverage) {
    if (coverage.has("complete") && !coverage.optBoolean("complete"))
      text.append(
          "\n"
              + "Underlaget är ofullständigt. Kontrollera fullständig rapportexport och journal"
              + " innan rapporten används.\n");
  }
}
