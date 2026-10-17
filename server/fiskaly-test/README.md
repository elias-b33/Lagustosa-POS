# Fiskaly SIGN SE – förberedelse för TEST

Status 2026-10-17: kontraktstestad lokalt, ingen extern fiskaly-anslutning har provats. Denna modul är ett separat utvecklarverktyg. Den implementerar inte kassans `FiscalAdapter`, aktiveras inte av kassaservern och får inte användas för att godkänna betalningar. `FISCAL_ADAPTER=simulator` och produktionsspärren behålls.

## Vad som finns

- TEST-låst serverklient, autentisering, begränsad svarsstorlek, timeout, skydd mot omdirigering och felmeddelanden utan nycklar eller råa leverantörssvar.
- Separata systemkopplingar för varje register; samma system-ID får inte användas av två lokala kassor. Resurs-ID:n är UUIDv7, medan omsändningsnycklar är UUIDv4.
- Anrop för start/slut, köpavsikt, övningskvitto, artikelretur och en kopia av ett tidigare TEST-kvitto. Belopp kommer från betalningens historiska artikelandelar, inte hela notan. Skattebelopp och antal ändras inte för att få anropet att passa.
- Separat beständig anropskö. Den vägrar öppna kassadatabasen. Payload och omsändningsnyckel sparas före nätverksanropet. Organisation och kassakoppling låses till kön. API-hemligheter och JWT sparas inte där.
- Okänt svar förblir okänt. En känd fjärrreferens följs upp med GET. Ett förlorat första svar kan omsändas med samma body och nyckel inom ett konservativt 23-timmarsfönster; därefter krävs manuell leverantörsavstämning. Tillbakaflyttad klocka spärrar också omsändning. Detta bygger på specifikationens angivna standardlivslängd på 24 timmar för idempotenscachen.

Alla svar har som mest status `received-unverified`. `COMPLETED` betyder inte att svensk kontrollregistrering eller `STATUS_OK` har verifierats. `compliance` måste provas mot leverantörens faktiska svar innan en adapter får aktivera försäljning.

## Konto och första anslutning

Fiskaly har en egen TEST-miljö på `https://test.api.fiskaly.com`. Den kräver konto i HUB och API-åtkomst. Den publika dokumentationen är inte en anonym transaktionssandbox.

För operativa anrop behövs en TEST-nyckel för restaurangens UNIT och två separata driftsatta `FISCAL_DEVICE`-resurser under rätt restaurang/plats. Tillverkningsnummer och system-ID ska komma från fiskaly, inte genereras eller ersättas av lokala register-ID:n. Inget konto, avtal, system eller myndighetsärende skapas av våra verktyg.

Konfigurera endast i serverns privata miljö:

- `FISKALY_TEST_API_KEY`
- `FISKALY_TEST_API_SECRET`
- `FISKALY_TEST_UNIT_ID`
- `FISKALY_TEST_BINDINGS`: JSON-array med `{ "registerId": "lokal permanent kassaidentitet", "systemId": "UUIDv7 från fiskaly" }` för varje kassa.

Kör `npx tsx scripts/fiskaly-test-check.ts` för konfigurationskontroll utan nätverksanrop. När TEST-åtkomst finns gör `npx tsx scripts/fiskaly-test-check.ts --connect` en autentisering och läser de angivna systemen. Den kommandovägen skapar inga kassor eller kvitton och ändrar inte kassaprogrammets läge. Nycklar får inte läggas i webbvariabler, kommandoradsargument, Git eller skärmbilder. Verktyget läser inte automatiskt någon `.env`.

## Nästa steg före anslutning av POS-flödet

1. Prova den riktiga TEST-behörigheten, systemkopplingen, driftsättningsuppgifterna och faktiska svar. Bekräfta även att aktuell SIGN SE-version är tillgänglig för kontot.
2. Fastställ och testa svensk tolkning av status, kontrollkod, tillverkningsnummer och kontrollserver-ID. Anropsformatet räcker inte för att avgöra att en försäljning får avslutas.
3. Koppla startkontroll och godkänd köpavsikt före betalningen, efterföljande registrering, stängning och fel-/avbrottshantering till POS. Den nuvarande simulatoradaptern anropas efter betalning och kan inte bara bytas ut.
4. Verifiera retur- och kopiesemantik samt referenser. Förberedelsen skickar träning och benämner simulerade betalningssätt `OTHER / ELEVA TEST …`; riktiga kortuppgifter uppfinns inte. Dricks, retur över kassagräns, nollmomskategorier och bråk som inte kan uttryckas exakt med åtta decimaler spärras tills korrekt mappning är fastställd.
5. Testa avbrott, okända svar, omstart, behörighetsfel och avstämning mot leverantörens data, inklusive återställning av en äldre lokal databas. Separat anropskö måste säkerhetskopieras tillsammans med kassans underlag inför eventuell framtida drift.
6. Färdigställ föreskriven kvittokopie-XML med verkligt sparade kontrolluppgifter, provning, versionsunderlag och tillverkarens efterlevnadsbedömning. TEST-resultat är inte produktcertifiering.

## Kontraktskälla och verifiering

Anropsformatet bygger på [SIGN SE OpenAPI 2026-06-01](https://workspace.fiskaly.com/specs/fiskaly.uapi.sign-se.2026-06-01.yaml), hämtad 2026-10-17. Filen `tests/fixtures/fiskaly-sign-se-request-schema.json` innehåller de beroende valideringsschemana utan dokumentationstext samt källadress och SHA-256. De offentliga guideexemplen använder på flera ställen en annan form än schemat: platt body i stället för `content`, sammanslagen dokumenttyp, andra artikelklassvärden och andra betalningsfält. Kontraktstesterna använder specifikationens struktur; skillnaderna behöver bekräftas med fiskaly innan aktivering.

[Integrationsguide](https://workspace.fiskaly.com/de/sign-se/2026-06-01/integration-guide/) och [processbeskrivning](https://workspace.fiskaly.com/de/sign-se/2026-06-01/process-overview/) beskriver livscykeln. Lokala tester använder en uttrycklig falsk HTTP-mottagare, inte leverantörens TEST-system.

Kör `npx vitest run tests/fiskaly-test.test.ts tests/training-journal-xml.test.ts` för de avgränsade testerna.
