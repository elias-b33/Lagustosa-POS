# Prova Lagustosa i en säker testmiljö

Denna provversion använder **simulerade betalningar, simulerad kontrollenhet och utskriftsförhandsvisning**. Alla testkvitton är märkta TEST. Matmenyn har restaurangens 47 rätter och priser från den levererade PDF:en. De fyra förberedda dryckerna är märkta **Testpris**, eftersom PDF:en saknar dryckespriser. Bord och testprofiler är exempeldata. Använd påhittade beställningar för att prova serviceflödet.

## Start på denna dator

1. Dubbelklicka på **Start-Testmiljo.cmd** i projektmappen eller det uppackade Windows-paketet.
2. Verktyget väntar tills rätt testserver svarar, skriver adressen och öppnar webbläsaren: **http://127.0.0.1:4273/**.
3. Kontrollera texten **SÄKER TESTMILJÖ** på inloggningen. Välj **Ansvarig**, PIN **1234**. Enhetskod: **LAGUSTOSA-TEST**.
4. Gå till **Dagsöversikt → Öppna dagen**. Börja med **1 500 kr** i simulerad växelkassa.

Servern sparar sin separata databas, logg och backup under `%LOCALAPPDATA%\LagustosaPOS\safe-test\sessions\`. Utvecklingskassan på port 5173/4173 har en annan databas och inloggningssession. Startverktyget använder alltid träningsadaptrarna och läser ingen `.env` från projektet.

Du kan stänga startfönstret; testservern fortsätter i bakgrunden. Om du öppnar startverktyget igen återanvänds den verifierade testservern. **Stoppa-Testmiljo.cmd** stoppar bara servern vars identitet stämmer med testmiljön. Starta den igen för att fortsätta samma testomgång.

**Ny-Testomgang.cmd** stoppar den aktuella testservern och öppnar en ny tom testomgång. Tidigare omgångars databaser, loggar och säkerhetskopior sparas i sina egna mappar. Den nya omgången börjar med standardprofilerna och restaurangens matmeny. Avsluta först betalningsdialoger i gamla flikar; stäng eller ladda om dem efter bytet.

Menyuppdateringen gäller nya orderrader. Äldre notor, bongar och kvitton behåller sina sparade priser, och den tidigare menyn arkiveras i databasen. Prova gärna **Antipasto della casa → Medio** (255 kr) och **Filetto di manzo** (355 kr) med tillbehör, sås och stekning. Välj **Storlek**, **Tillbehör**, **Sås** eller **Stekning** i artikelns dialog innan den läggs på notan.

Sparade betalnings- och returförsök i webbläsaren hör till respektive testomgång. En ny omgång visar inte gamla försök och raderar inte deras lagring.

## Profiler och enheter

| Testprofil | PIN | Enhetskod | Syfte |
|---|---|---|---|
| Ansvarig | 1234 | LAGUSTOSA-TEST | Huvudkassa, inställningar, avstämning |
| Kassa | 2345 | LAGUSTOSA-TEST | Huvudkassa och kontanter |
| Servering | 3456 | SERVERING-1 till SERVERING-4 | Beställning och simulerad kortbetalning vid bord |
| Kök | 4567 | KOK-TEST | Första köksskärmen |
| Kök | 4567 | KOK-TEST-2 | Andra köksskärmen |
| Bar | 5678 | BAR-TEST | Barskärmen |

Enhetskoden kan ändras under **Enhet och testprofiler** på inloggningssidan. Olika flikar i samma webbläsarprofil delar inloggning. För att prova flera personer på samma dator använder du skilda webbläsarprofiler, eller exempelvis Edge normalt och Chrome normalt. Varje riktig testplatta har sin egen webbläsarsession.

Planerad utrustning: **1 huvudkassa, 4 enheter för beställning och betalning, 3 iPads för order och 3 skrivare**. I testversionen motsvaras skrivarna av profilerna **Kvittoskrivare**, **Köksskrivare** och **Barskrivare**. Dessa förhandsvisar text; fysisk kortläsare och utskrift kopplas när nya modeller och betalningsleverantör är valda.

## Ett första test på cirka 20 minuter

| Steg | Gör så här | Kontrollera |
|---|---|---|
| 1. Bord och gäster | Öppna Bord 01 för två gäster. Lägg Vitlöksbröd och Penne manzo e peperoncino på gäst 1, samt Husets röda på gäst 2. | Rätt bord, gäster och belopp syns på notan. |
| 2. Kök och bar | Välj **Skicka till kök & bar**. Öppna respektive station. | Förrätten går till kök, vinet till bar, huvudrätten väntar. |
| 3. Huvudrätt | Återgå till notan och välj **Fram huvudrätt**. | En egen huvudrättsbong visas i köket. Prova stationens statusknappar. |
| 4. Delad betalning | Öppna **Ta betalt → Dela lika**, välj två delar. Ange simulerad dricks. | Beloppen fördelas i hela ören; dricks är separat. |
| 5. Nekat kort | Välj det nekade testsvaret och skicka betalningen. | Försäljningen registreras inte som betald; du kan göra ett nytt försök. |
| 6. Okänt svar | Öppna **Välj testscenario**, välj **Förlorat svar · okänd status** och skicka. Använd **Kontrollera** tills resultatet visas. | Samma försök kontrolleras. Ett nytt kortköp skapas inte under osäkerheten. |
| 7. Kvitto | Prova förlorat kontrollenhetssvar och verifiera registreringen. Betala sedan resterande del. | Testkvitton, betalsätt och dricks stämmer; notan blir betald. |
| 8. Retur | Gå till **Dagsöversikt**, öppna ett kortköp och gör en liten retur med orsak. | En separat retur visas och originalkvittot bevaras. |
| 9. Utskrift | Öppna **Utskrifter**. Förhandsvisa köks-, bar- och kvittotext. Prova osäkert utskriftssvar. | Rätt skrivare syns. Kontroll krävs före märkt återutskrift. |
| 10. Dagsavslut | Kontrollera försäljning, retur, dricks, kassabehållning och rapport per kassa. Avsluta dagen när alla öppna notor är hanterade. | Rapporten stämmer; CSV, JSON-underlag och verifierad backup kan skapas. XML kräver att exportkontrollen godkänner datainnehållet. |

Byt **Utseende → Cotto / Professionell / Klassisk** medan en nota är öppen. Samma nota och belopp ska finnas kvar. Cotto är det nya grundutseendet; båda tidigare utseendena finns kvar i samma väljare. På smal skärm använder du **Visa nota / Till menyn** längst ned för att växla mellan beställning och nota.

Prova också en liten kontantnota från huvudkassan och kontrollera växel. Serveringsenheterna tillåter inte kontantförsäljning.

Prova de uppdaterade beställnings- och betalningsflödena:

- Välj ingen aktuell nota och tryck på **Antipasto della casa**. Öppna disknotan: samma rätt ska öppnas direkt och kräva val av storlek.
- Öppna en rätt med tillval. Om menyn ändras från en annan enhet visas en uppmaning att kontrollera pris och val. Ett borttaget obligatoriskt tillval måste väljas på nytt; antal och anteckning bevaras.
- Makulera en skickad rätt med orsak. Köket får en separat makuleringsbong; raden i originalbongen märks **Makulerad**. En helt makulerad originalbong finns under **Visa historik** och kan inte startas igen.
- Vid flera Swish-delbetalningar ska varje ny del kräva en egen verifiering. Vid kontant delbetalning ska mottaget belopp anges på nytt. Dricks börjar på noll för nästa del.

## Flera enheter och avbrott

- Logga in två serveringsprofiler på olika enheter/webbläsarprofiler. Lägg artiklar på samma bord och kontrollera att båda ser ändringarna.
- Gå till **Inställningar → Enheter** som Ansvarig. **Skärmansluten** betyder att appen har en aktiv anslutning; det är inte ett besked om bankterminal eller fysisk skrivare.
- Öppna en betalningsdialog, välj ett okänt testresultat och ladda om sidan. **Återuppta betalning** ska öppna samma sparade försök. Kontrollera resultatet innan du gör ett nytt köp.
- Prova kort nätverksavbrott på en testplatta och återanslut. Servern är källan till order och belopp; appen ska visa den aktuella notan efter återanslutning.

Automatiserade tester provar även ett förlorat svar *efter* att en betalning eller retur har registrerats, och kontrollerar att samma köp/retur hämtas utan en dubbel registrering.

## AW med 36 eller 90 samtidiga gäster

`scripts/simulate-aw.mjs` kör en reproducerbar AW mot appens riktiga HTTP-API med simulatorer. Den kräver en **ny tom datamapp** och en separat port; befintliga testomgångar ändras inte. Tillfälliga AW-bord får sex platser vardera enbart i denna databas. Standard är 36 gäster på sex bord. `--guests 90` ger 15 bokningar. Utvecklings-, E2E- och befintliga demoportar, bland annat 4273 och 4373, är spärrade för simulatorn.

Scenariot använder huvudkassa, fyra serveringsprofiler och tre virtuella orderskärmsanslutningar. Det lägger 54 drycker, 12 delningsfat och 36 huvudrätter, framkallar väntande huvudrätter, byter en pizza och provar samtidiga ändringar på samma nota. Två köksskärmar ska få samma kö, baren en separat kö. Varje aktiv orderrad kontrolleras mot exakt en stationsrad, inklusive gäst, val och anteckning.

Efter `npm run build` kan en full körning startas så här:

```powershell
$awRoot = Join-Path $env:LOCALAPPDATA ('LagustosaPOS\aw-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
node scripts/simulate-aw.mjs --root "$awRoot\full" --port 4383 --mode full
```

Den fulla standardkörningen lägger även 12 desserter och 12 kaffe, gör 36 lika delbetalningar (sex per bord) med kort, verifierad Swish och kontanter, provar nekat/osäkert svar, kvittoåterhämtning och en osäker utskrift med märkt kopia. En gästkvittokopia tillåts; en andra kopia och kopia av kopia spärras. Kontantinsättning och uttag provas med återförsök. Dagen stängs, journalen kontrolleras och backup skapas. Servern stoppas efteråt.

För en större bokning med **90 gäster och en betalning per gäst**:

```powershell
node scripts/simulate-aw.mjs --root "$awRoot\full-90" --port 4483 --mode full --guests 90 --split guest --pace-ms 25
```

Alla 15 bokningar öppnas i samma ankomstfas. Fyra serveringsklienter arbetar parallellt med 135 drycker, 30 delningsfat och 90 huvudrätter, följt av 30 desserter och 30 kaffe. Gäster 1–5 betalar sina egna rader; gäst 6 betalar sina och bordets gemensamma fat. `--split equal` behåller lika delning. `--pace-ms` är en syntetisk paus mellan kommandon, inte verklig köks- eller gästtid. Gästantalet kan väljas i hela grupper om sex, från 36 till 180.

Rapporten `aw-report.json`, den separat beräknade planen `aw-expected.json` och anropsspåret `aw-http.json` sparas under vald mapp. Förväntade mängder, belopp, moms och kontantkassa beräknas från beställningsplanen och ursprungsmenyn, utan att använda serverns betalningsbelopp som facit. Varje aktiv rad kontrolleras mot station och slutlig betalning. Rapporten skiljer avsiktliga fel från oväntade HTTP-/transportfel och redovisar faktisk samtidighet samt svarstider.

Körningen den 13 oktober 2026 med 90 gäster passerade: **1 557 HTTP-anrop, högst fyra samtidigt, inga oväntade fel, 90 betalningar, 90 kvitton och noll kassadifferens**. Försäljningen blev 40 109 kr, dricks 150 kr och moms 4 854,81 kr. Fem separata Z-rapporter och deras grand totals stämdes av mot restaurangens totalsumma. Median/p95/max var 4/26/141 ms. Förloppet var komprimerat till 5,3 sekunder och bevisar inte uthållighet under ett helt arbetspass eller 99 procent tillgänglighet.

För att lämna en separat demonstration **mitt i rusningen**:

```powershell
node scripts/simulate-aw.mjs --root "$awRoot\preview-90" --port 4493 --mode rush --guests 90
```

Öppna `http://127.0.0.1:4493/#kitchen` och logga in som **Ansvarig / 1234 / LAGUSTOSA-TEST**. Gå mellan **Bord**, **Kök**, **Bar** och **Utskrifter**. Använd statusknapparna för att själv fortsätta serveringen. För att stoppa just demonstrationen utan att ta bort data:

```powershell
node scripts/safe-test.mjs stop --root "$awRoot\preview-90" --port 4493 --no-browser
```

Detta är ett komprimerat lokalt arbetsflödestest. Åtta virtuella anslutningar motsvarar inte ett verifierat test på åtta fysiska enheter. Mätta HTTP-tider är inte iPad-skärmarnas uppdateringstid eller kökets kapacitet. Dryckernas exempelpriser är kvar, så omsättningen är ingen AW-offert. Utskrifter hanteras genom testadaptern; ingen fysisk skrivare eller automatisk utskriftsbrygga är ansluten.

## Prova iPads på ett privat testnät

Den snabba starten ovan är begränsad till denna dator. För enhetstest på restaurangens privata nät använder testverktyget HTTPS och en egen lokal certifikatutfärdare.

1. Anslut datorn och testplattorna till samma privata nät. Läs datorns **IPv4-adress** med `ipconfig` (exempel: `192.168.1.50`).
2. Stoppa testmiljön med **Stoppa-Testmiljo.cmd**.
3. Kör från den uppackade projekt-/paketmappen, med **datorns egen adress**:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-safe-test.ps1 -LanAddress 192.168.1.50 -NoBrowser
   ```

4. Startverktyget skapar lokala certifikat i testmappen och skriver sökvägen till **Lagustosa-Test-CA.cer** och dess SHA-256-fingeravtryck. Kopiera endast den offentliga `.cer`-filen till testenheterna. Privata nycklar stannar på datorn.
5. Installera certifikatet genom enhetens vanliga certifikathantering och jämför fingeravtrycket med startfönstret. På iPad installeras profilen och certifikatförtroendet aktiveras under **Inställningar → Allmänt → Om → Inställningar för betrodda certifikat**. Se [Apples instruktion för manuellt installerade certifikat](https://support.apple.com/sv-se/102390). På Windows kan rotcertifikatet installeras i den aktuella användarens betrodda rotcertifikatutfärdare.
6. Tillåt vid behov inkommande TCP-port **4273** för datorns **privata nätverksprofil**, begränsad till det lokala testnätet. Använd ingen portvidarebefordran till Internet.
7. Öppna **https://192.168.1.50:4273/** på plattorna. Logga in med varsin enhetskod från tabellen. Kontrollera att webbläsaren visar en betrodd HTTPS-anslutning.

Startverktyget ändrar inte certifikatförtroende eller brandvägg automatiskt. Den automatiserade LAN-kontrollen verifierar servercertifikatets kedja och adresser utan att installera rotcertifikatet. Själva nätverket och iPad-installationen provas på plats.

Den här versionen stöder webbläsare. Om en kommande fysisk betalterminal ska köra vår beställningsapp måste modellen även stödja en sådan app eller ha en kompatibel integration.

## Om något behöver kontrolleras

Startfönstret skriver den aktiva testomgångens `server.log` och datamapp. Spara felmeddelandet, vilket bord det gällde, vad du klickade på och vilken enhetsprofil du använde. Kontrollera befintligt betalningsresultat efter ett avbrott innan du försöker igen. Vid osäker utskrift används kökontrollen innan en kopia görs.

Manuell backup finns under **Dagsöversikt**. Automatisk backup tas varje timme och efter dagsavslut. Varje testomgång har sin egen `backups`-mapp. Kopiera både `.sqlite` och den tillhörande `.sqlite.manifest.json` till separat lagring. Återläsning kontrollerar filens SHA-256, databas och journal, sparar en säkerhetskopia av föregående databas och avslutar gamla inloggningssessioner. Se återställningskommandot i README. Manifestet är ingen digital signatur eller skyddad arkivtjänst.

## Prova kassaidentiteter, artikelantal och journalurval

1. Kontrollera **Administration → Enheter**: huvudkassan och fyra serveringsenheter har olika permanenta kassaidentiteter. Orderskärmarna har ingen. Namnbyte eller ny enhetskod ska behålla identiteten.
2. Skapa en nota med tre likadana artiklar. Under **Ta betalt → Artiklar → Välj antal av varje artikel**, betala en artikel. Testkvittot ska visa ett exemplar; två återstår. Ett för stort antal spärras.
3. Betala resten från en annan serveringsenhet. Jämför kassaidentitet och kvittonummer på kvittona. Varje kassa har sin egen serie; samma nummer kan därför finnas på två olika kassor.
4. Under **Dagsöversikt → Retur**, välj **Valda artiklar och antal**. Återför ett exemplar och kontrollera antal, belopp, moms och referensen till originalkvittot. Försök återföra för mycket; det ska avvisas.
5. Prova en beloppsdelad nota med mat och vin. Välj **Valda kvittorader** vid retur och markera bara vinet. Endast vinets betalningsandel och moms ska återföras. En global beloppsretur fördelas däremot över alla återstående rader.
6. Välj **Rapport per kassa** och jämför de olika kassorna. Avsluta dagen och kontrollera att de sparade Z-rapporterna har sina egna nummer. Följande dags aktivitet får inte ändra dem.
7. Under **Exportera journal**, välj en kassa och datum. Läs eventuella XML-spärrorsaker. Prova JSON-utdraget som administratör. Saknat artikelantal, oklassificerade artiklar, övningskvittokopior, andelar med fler än två decimaler eller negativa träningsnetton kan spärra XML; det är ett redovisat implementationsgap, inte en lyckad juridisk export.
8. För en positiv XML-kontroll, använd en ny isolerad testomgång, ange vara/tjänst för både servering och avhämtning på testartiklarna **före beställningen**, och prova hela artikelantal utan kopior. Verifiera exporterad fil med `python scripts/validate-journal-xml.py "journal.xml"`. Klassificeringen påverkar nya orderrader och får inte skriva om gamla kvitton.

Alla dessa steg gäller träningsmodellen. Godkända resultat ersätter inte tillverkardeklaration, verifiering med certifierad kontrollösning eller kundens installationsanmälan.

För teknisk verifiering från källkoden:

```powershell
npm test
npm run build
npm run test:safe-env
npm run test:e2e
```

Det här är ett test av restaurangflödet. Kundförsäljning fortsätter i den befintliga kassan tills de riktiga betalnings-, skrivar- och kontrollenhetskopplingarna är färdiga och installationen är verifierad för drift.
