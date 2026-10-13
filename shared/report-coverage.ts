const explanations: Record<string, string> = {
  REGISTER_HISTORY_START_UNPROVEN: 'Kassans första registrering saknas i underlaget för de ackumulerade räknarna.',
  APPROVED_PAYMENT_WITHOUT_RECEIPT: 'En godkänd betalning saknar registrerat kvitto.',
  UNRESOLVED_RECEIPT_CONTROL: 'Ett registrerat kvitto har ännu inte bekräftats av kontrollsimulatorn.',
  INVALID_GRAND_TOTAL_RECEIPT: 'Ett kvittos belopp eller typ kan inte användas i den ackumulerade räknaren.',
  RETURN_ORIGINAL_RECEIPT_UNPROVEN: 'Originalkvittot för en retur kan inte verifieras.',
  RETURN_EXCEEDS_ORIGINAL_RECEIPT: 'Ackumulerade returer överstiger originalkvittot. Underlaget behöver utredas.',
  MISSING_QUANTITY: 'Äldre registreringar saknar sparat artikelantal.',
  AMOUNT_SHARE_IS_NOT_PHYSICAL_QUANTITY: 'Beloppsdelningar innehåller ekonomiska artikelandelar. Dessa räknas separat från fysiska antal.',
  MISSING_QUANTITY_BASIS: 'Det saknas uppgift om antalet avser artiklar eller en ekonomisk andel.',
  MISSING_GOODS_SERVICE_CLASSIFICATION: 'Vara eller tjänst var inte angivet när vissa artiklar beställdes. Ange klassificeringen i menyn för kommande beställningar.',
  MISSING_RECEIPT_SNAPSHOT: 'Ett fullständigt historiskt kvittounderlag saknas.',
  ALLOCATION_TOTAL_MISMATCH: 'Betalningens artikelbelopp stämmer inte med totalsumman. Underlaget behöver utredas.',
  MISSING_HISTORICAL_CATEGORY: 'Historisk varugrupp saknas för vissa artiklar.',
  MISSING_DISCOUNT_ALLOCATION: 'Äldre registreringar saknar sparad rabattfördelning.',
  LEGACY_REGISTER_SCOPE: 'Äldre gemensam kassahistorik kan inte fördelas på dagens enheter.',
  MISSING_DAY_OPEN_EVENT: 'Dagens öppningshändelse saknas i journalunderlaget.',
  MISSING_HISTORICAL_COMPANY: 'Historiska företagsuppgifter saknas.',
  MISSING_Z_SEQUENCE: 'Kassans historiska Z-rapportnummer saknas.',
  PAYMENT_RECEIPT_REGISTER_CONFLICT: 'Betalning och kvitto har olika kassaidentiteter. Underlaget behöver utredas.',
  INVALID_CASH_MOVEMENT: 'En kontantregistrering innehåller ofullständiga uppgifter.',
  MISSING_COPY_RECEIPT_SNAPSHOT: 'Historiskt kvittounderlag saknas för en kopia.',
  MISSING_PARKING_REGISTER: 'Kassan där en parkerad nota öppnades kan inte fastställas.',
  NEGATIVE_OPEN_TAB_BALANCE: 'En öppen notas betalningssaldo behöver utredas.',
  PAYMENT_WITHOUT_JOURNAL_SNAPSHOT: 'En betalning saknar motsvarande historik i journalen.',
  RECEIPT_WITHOUT_JOURNAL_SNAPSHOT: 'Ett kvitto saknar motsvarande historik i journalen.',
};

export function reportCoverageExplanation(code: string): string {
  return explanations[code] ?? `Underlaget behöver granskas (${code}).`;
}
