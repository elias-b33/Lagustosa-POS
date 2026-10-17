# XML-export av träningsjournal och kvittokopior

Ansvarig hittar **Träningsunderlag XML · med kopior** under journalexporten. Knappen använder samma period- och kassafilter som övriga exporter. API: `GET /api/v1/journal-training.xml`. Samma administratörsbehörighet som fullständig JSON-journal krävs.

Exporten är ett separat format med namnrymden `urn:eleva:training-journal:1`, version 1 och tydliga markeringar `training="true"` samt `skatteverketStandard="false"`. Den innehåller:

- Originaljournalens poster, hashvärden och föregående hash samt uppgift om filtreringens omfattning. Fältet `Details` innehåller JSON-text utan ändrade uppgifter.
- En separat `ReceiptCopies`-lista med kopians journalpost, utskrifts-ID, tidpunkt, utfärdande kassa, belopp när journalfört, orsak och originalreferenser.
- Originalkvittots kassa, löpnummer, datum, kvittotyp och ögonblicksbild. Originalet kan ligga utanför vald period eller tillhöra en annan kassa. Det redovisas som referensunderlag, inte som en ny försäljning i urvalet.
- Befintliga uppgifter för både nya och äldre kopiehändelser som använde `sourceId`. Saknat original markeras med `originalAvailable="false"`; uppgifter och löpnummer gissas inte.
- Täckningsrapport för Skatteverkets standardformat, så kvarstående standardexportbrister fortfarande framgår.

Framställningen läser underlaget utan att ändra tidigare journalposter, kvitton, register eller ekonomiska räknare. Ett lyckat API-uttag lägger därefter till en vanlig exporthändelse i journalen. Ogiltiga XML-tecken och autentiseringsuppgifter spärrar export; använd JSON för tecken som XML inte tillåter.

## Varför det finns två XML-format

Skatteverkets oförändrade XSD innehåller `KopiaAvKassakvitto`, men kräver en av de specificerade kontrollreferenserna för originalet. Våra historiska simulatorvärden `TEST-…` är inte sådana kontrollkoder. Schemat har inget särskilt element för en kopia av ett övningskvitto.

Standardexporten `/api/v1/journal.xml` fortsätter därför stoppa dessa kopior. Vi fyller inte ut simulatorsträngar till en påhittad kontrollkod, betecknar inte övningskopior som nya försäljningar och påstår inte att ett verkligt kontrollserveravbrott inträffat. Elevas tränings-XML gör hela testunderlaget tillgängligt utan någon sådan omskrivning. Den ersätter inte XML-export enligt SKVFS 2021:16.

Standardexporten behöver kompletteras när faktisk kontrollösning, kopiedokument och verifierade kontrollreferenser finns. Fullständig rättslig efterlevnad är fortfarande inte verifierad.
