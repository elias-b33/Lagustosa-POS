# Prova Lagustosa i en säker testmiljö

Denna provversion använder **simulerade betalningar, simulerad kontrollenhet och utskriftsförhandsvisning**. Alla testkvitton är märkta TEST. Meny, priser och bord är exempeldata. Använd påhittade beställningar för att prova serviceflödet.

## Start på denna dator

1. Dubbelklicka på **Start-Testmiljo.cmd** i projektmappen eller det uppackade Windows-paketet.
2. Verktyget väntar tills rätt testserver svarar, skriver adressen och öppnar webbläsaren: **http://127.0.0.1:4273/**.
3. Kontrollera texten **SÄKER TESTMILJÖ** på inloggningen. Välj **Ansvarig**, PIN **1234**. Enhetskod: **LAGUSTOSA-TEST**.
4. Gå till **Dagsöversikt → Öppna dagen**. Börja med **1 500 kr** i simulerad växelkassa.

Servern sparar sin separata databas, logg och backup under `%LOCALAPPDATA%\LagustosaPOS\safe-test\sessions\`. Utvecklingskassan på port 5173/4173 har en annan databas och inloggningssession. Startverktyget använder alltid träningsadaptrarna och läser ingen `.env` från projektet.

Du kan stänga startfönstret; testservern fortsätter i bakgrunden. Om du öppnar startverktyget igen återanvänds den verifierade testservern. **Stoppa-Testmiljo.cmd** stoppar bara servern vars identitet stämmer med testmiljön. Starta den igen för att fortsätta samma testomgång.

**Ny-Testomgang.cmd** stoppar den aktuella testservern och öppnar en ny tom testomgång. Tidigare omgångars databaser, loggar och säkerhetskopior sparas i sina egna mappar. Den nya omgången börjar med standardprofilerna och exempelmenyn. Avsluta först betalningsdialoger i gamla flikar; stäng eller ladda om dem efter bytet.

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
| 1. Bord och gäster | Öppna Bord 01 för två gäster. Lägg Vitlöksbröd och Penne Manzo på gäst 1, samt Husets röda på gäst 2. | Rätt bord, gäster och belopp syns på notan. |
| 2. Kök och bar | Välj **Skicka till kök & bar**. Öppna respektive station. | Förrätten går till kök, vinet till bar, huvudrätten väntar. |
| 3. Huvudrätt | Återgå till notan och välj **Fram huvudrätt**. | En egen huvudrättsbong visas i köket. Prova stationens statusknappar. |
| 4. Delad betalning | Öppna **Ta betalt → Dela lika**, välj två delar. Ange simulerad dricks. | Beloppen fördelas i hela ören; dricks är separat. |
| 5. Nekat kort | Välj det nekade testsvaret och skicka betalningen. | Försäljningen registreras inte som betald; du kan göra ett nytt försök. |
| 6. Okänt svar | Öppna **Välj testscenario**, välj **Förlorat svar · okänd status** och skicka. Använd **Kontrollera** tills resultatet visas. | Samma försök kontrolleras. Ett nytt kortköp skapas inte under osäkerheten. |
| 7. Kvitto | Prova förlorat kontrollenhetssvar och verifiera registreringen. Betala sedan resterande del. | Testkvitton, betalsätt och dricks stämmer; notan blir betald. |
| 8. Retur | Gå till **Dagsöversikt**, öppna ett kortköp och gör en liten retur med orsak. | En separat retur visas och originalkvittot bevaras. |
| 9. Utskrift | Öppna **Utskrifter**. Förhandsvisa köks-, bar- och kvittotext. Prova osäkert utskriftssvar. | Rätt skrivare syns. Kontroll krävs före märkt återutskrift. |
| 10. Dagsavslut | Kontrollera försäljning, retur, dricks och kassabehållning. Avsluta dagen när alla öppna notor är hanterade. | Rapporten stämmer; CSV, journal-XML och backup kan skapas. |

Byt **Utseende → Professionell / Klassisk** medan en nota är öppen. Samma nota och belopp ska finnas kvar. På smal skärm använder du **Visa nota / Till menyn** längst ned för att växla mellan beställning och nota.

Prova också en liten kontantnota från huvudkassan och kontrollera växel. Serveringsenheterna tillåter inte kontantförsäljning.

## Flera enheter och avbrott

- Logga in två serveringsprofiler på olika enheter/webbläsarprofiler. Lägg artiklar på samma bord och kontrollera att båda ser ändringarna.
- Gå till **Inställningar → Enheter** som Ansvarig. **Skärmansluten** betyder att appen har en aktiv anslutning; det är inte ett besked om bankterminal eller fysisk skrivare.
- Öppna en betalningsdialog, välj ett okänt testresultat och ladda om sidan. **Återuppta betalning** ska öppna samma sparade försök. Kontrollera resultatet innan du gör ett nytt köp.
- Prova kort nätverksavbrott på en testplatta och återanslut. Servern är källan till order och belopp; appen ska visa den aktuella notan efter återanslutning.

Automatiserade tester provar även ett förlorat svar *efter* att en betalning eller retur har registrerats, och kontrollerar att samma köp/retur hämtas utan en dubbel registrering.

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

Manuell backup finns under **Dagsöversikt**. Automatisk backup tas varje timme och efter dagsavslut. Varje testomgång har sin egen `backups`-mapp. Filerna ligger på denna dator; kopiera en verifierad backup till separat lagring för att också prova en extern kopia.

För teknisk verifiering från källkoden:

```powershell
npm test
npm run build
npm run test:safe-env
npm run test:e2e
```

Det här är ett test av restaurangflödet. Kundförsäljning fortsätter i den befintliga kassan tills de riktiga betalnings-, skrivar- och kontrollenhetskopplingarna är färdiga och installationen är verifierad för drift.
