# Lagustosa Kassa

Restaurangens egen lokala webbapp för huvudkassa, bordsservering, kök och bar. Servern körs på en Windows-laptop; personalens enheter använder webbläsaren.

**Den här versionen är en träningskassa.** Betalningar, kontrollenhet och skrivare är simulatorer. Gränssnitt, kvitton och rapporter är märkta `TEST — inga riktiga betalningar`. Produktionsläge är spärrat i servern.

## Starta utvecklingen

Installera Node.js 24 och kör från projektmappen:

```powershell
npm ci
npm run dev
```

Öppna <http://127.0.0.1:5173/>. Gränssnittet uppdateras automatiskt när koden ändras. API-servern använder port 4173. Utvecklingsvyn är begränsad till datorn som kör den.

Använd profilen **Ansvarig**, PIN **1234** och enhetskoden **LAGUSTOSA-TEST**. Gå till **Dagsöversikt → Öppna dagen** innan första beställningen.

| Testprofil | PIN | Enhetskod |
|---|---|---|
| Ansvarig | 1234 | LAGUSTOSA-TEST |
| Kassa | 2345 | LAGUSTOSA-TEST |
| Servering | 3456 | SERVERING-1 till SERVERING-4 |
| Kök | 4567 | KOK-TEST eller KOK-TEST-2 |
| Bar | 5678 | BAR-TEST |

Testkoderna visas även under **Enhet och testprofiler** på inloggningssidan. Dessa är avsedda för träning. Meny, bord, personal och enheter kan ändras i **Inställningar**. Menyn och bordsplaceringen är exempeldata.

## Det som går att prova

- Bord och disknotor, försäljning på plats eller avhämtning, gäster, tillval och köksanteckningar.
- Separata köks- och barbongar, väntande huvudrätter och framkallning.
- Flytt av bord med uppdaterad information till stationerna.
- Delning per gäst, artikel, delbelopp eller lika delar, samt separat dricks.
- Godkänd, nekad, avbruten och okänd betalning; kontroll av samma försök efter ett förlorat svar.
- Returer till samma simulerade betalsätt, bevarade originalkvitton och journal.
- Utskriftsförhandsvisning med misslyckad/osäker status och märkt återutskrift.
- Växelkassa, kontantavstämning, dagsavslut, CSV och journal-XML för träning.
- Roller, PIN-koder, enhetsregistrering och datumstyrda momsregler.

## Ett komplett träningsscenario

1. Logga in som Ansvarig och öppna dagen med 1 500 kr växelkassa.
2. Öppna Bord 01 för två gäster. Lägg Vitlöksbröd och Penne Manzo på gäst 1 samt Husets röda på gäst 2.
3. Skicka till kök och bar. Kontrollera respektive station: huvudrätten ska fortfarande vänta.
4. Återgå till kassan och välj **Fram huvudrätt**.
5. Öppna **Ta betalt → Dela lika**. Prova först en nekad betalning.
6. Välj förlorat betalningssvar. Kontrollera samma försök tills dess verkliga simulerade status visas.
7. Prova ett förlorat kontrollenhetssvar och verifiera befintlig registrering. Slutför resterande delbetalning och visa testkvittot.
8. Stäng dagen, kontrollera avstämningen och hämta CSV/journal-XML.

## Tester och byggd version

```powershell
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Vitest verifierar belopp, datumstyrd moms, samtidiga order, delbetalningar, returer, utskrifter, åtta anslutna SSE-klienter, omstart, backup och TLS-kedja. Playwright provar restaurangflödet i webbläsaren, två samtidiga servitörer och responsiv layout. Browser-tester använder en separat tillfällig databas på port 4183.

GitHub Actions kör tester och bygge på Windows och Linux. Testbilder sparas lokalt i `artifacts/`; de är inte versionshanterade.

För att köra den byggda versionen på datorn:

```powershell
npm run build
npm start
```

Öppna <http://127.0.0.1:4173/>. Stäng servern med Ctrl+C i terminalen. Utvecklingsserver och byggd server ska inte köras samtidigt mot samma databas.

## Lokal installation och plattor

Använd en lokal installationsmapp på restaurangens laptop, exempelvis `C:\Lagustosa-Kassa`. Den aktiva SQLite-databasen ska ligga på datorns egen disk, utanför OneDrive eller en annan synkroniserad mapp. Säkerhetskopior kan däremot flyttas till separat lagring.

Kopiera `.env.example` till `.env`, ange `DATA_DIR=C:/Lagustosa-Data` och en separat `BACKUP_DIR`, exempelvis en USB-disk. Behåll `APP_MODE=training`.

```powershell
npm run certs -- 192.168.1.20
npm run build
npm start
```

Ersätt exempeladressen med serverns reserverade adress i restaurangens nätverk. `.env.example` aktiverar HTTPS på port 4173 och lyssnar på det lokala nätverket. `TLS_CERT` och `TLS_KEY` måste båda peka på de skapade serverfilerna.

Certifikatverktyget skapar en lokal rot-CA och ett servercertifikat med datornamn och angivna IP-adresser. Det installerar inget rotcertifikat på datorn eller plattorna. Installera `certs/root-ca.pem` genom enhetens vanliga certifikathantering innan HTTPS används och kontrollera certifikatets fingeravtryck. På iPad behöver det installerade rotcertifikatet också aktiveras under certifikatförtroende. Serverns privata nycklar ska stanna på servern. Därefter öppnar plattorna `https://SERVERNS-IP:4173/` och får varsin enhetskod.

Tillåt port 4173 endast på restaurangens privata nätverk vid installation. Nätverk, certifikatförtroende och fysisk utrustning behöver provas på plats.

## Backup och återställning

Servern tar backup varje timme och efter dagsavslut. Manuell kopia finns vid huvudkassan och i terminalen:

```powershell
npm run backup
```

SQLite-backupen inkluderar bekräftade ändringar även när WAL används. CLI-verktyget kontrollerar databasens integritet och journalens kontrollsummor.

Stoppa servern innan återställning:

```powershell
npm run restore -- "E:\Backups\lagustosa-training-EXEMPEL.sqlite"
```

Återställning avvisas medan servern körs. Den tidigare databasen säkerhetskopieras före ersättningen. Prova återställning till en separat testinstallation innan rutinen används i restaurangen.

## Windows-paket och automatisk start

```powershell
npm run package:windows
```

Paketet i `releases/` innehåller byggd app, Node-runtime, driftberoenden och instruktioner. Databas, `.env` och privata certifikat följer inte med; dessa konfigureras på destinationsdatorn. Paketet går att köra utan npm-installation på destinationsdatorn.

`Start-Lagustosa.cmd` startar servern i bakgrunden. Automatisk start vid **inloggning på restaurangens Windows-konto** kan installeras separat:

```powershell
powershell -NoProfile -File scripts/install-autostart.ps1
```

Schemalagd aktivitet: `Lagustosa-Kassa-Training`. Laptopen ska ha nätverkskabel och inställningar som låter servern fortsätta köras när locket stängs.

## Teknisk grund och nästa integrationer

React/TypeScript/Vite, Fastify/Node 24 och SQLite (`better-sqlite3`, WAL, FULL synchronous). Servern är källa till alla belopp; pengar lagras som heltalsöre. Orderversioner och betalningsidentifierare skyddar mot förlorade ändringar och dubbel registrering. SSE uppdaterar enheterna med polling som reserv.

Adaptergränssnitten för betalning, kontrollenhet och skrivare finns i `server/adapters.ts`. Riktiga drivrutiner ska implementeras och provas mot valda modeller/leverantörer. Swish-verifieringen i denna version är ett testval, inte en bankintegration. Journal-XML är en träningsimplementation; produktionskrav och verifiering mot Skatteverkets schema ingår i arbetet inför riktig drift.

Före kunddrift återstår aktuell meny och bordsplan, betalningsleverantör, fysiska skrivare och certifierad kontrollenhet, dokumenterade tester och tillverkardeklaration samt registrering av installationen. Qpay kan fortsätta hantera kundförsäljning under provdriften.

Momsreglernas exempel följer Skatteverkets uppgifter om [6 % livsmedelsmoms för hämtmat från 1 april 2026 till 31 december 2027, och 12 % restaurangmoms](https://www.skatteverket.se/omoss/pressochmedia/nyheter/2026/nyheter/livsmedelsmomsensankstill6procent.5.70685bee19c85dd5dd0a3f.html). Läs också [informationen för tillverkare och leverantörer](https://www.skatteverket.se/foretag/drivaforetag/kassaregister/fortillverkareochleverantorer.4.6efe6285127ab4f1d2580006050.html).
