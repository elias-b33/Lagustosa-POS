# Verifiering av native-appen

Serverbas: GitHub-commit `7061d4a1011e67ae85ad86d7e4ee2f31795da5a8`. Android-kodens resultat nedan hör till denna separata native-gren och säger inget om webbklientens prestanda.

## Version 1.1.1, 2026-10-17

APK: `1.1.1-native-test`, versionCode 3, **234 947 byte**. SHA-256: `1ec1f61c0fcfbba1b8ba841af6e7e84360bc4541b3c4f478eff40fb359cc6c66`.

Riktad bugggenomgång av samtidiga notändringar, delbetalning, kök/bar och inloggning:

- Version 1.1.0 reproducerade ett fel i den faktiska installerade APK:n: en prisändring mellan bekräftad borttagning och serveranrop gav en versionskonflikt. Klienten ersatte då den gamla versionen och skickade borttagningen igen. **Två anrop**, raden makulerades trots att underlaget ändrats. Version 1.1.1 skickar **ett anrop**, behåller raden och visar det avvisade försöket. Förlorade svar återanvänder fortfarande originalets nyckel och innehåll. Efter en bekräftad skrivning hämtas ett aktuellt underlag på bakgrundstråden innan nästa skrivning aktiveras. [Jämförelse](docs/native-v111-conflict.json).
- Tillval och köksmeddelanden finns i både bonglistan och detaljvyn. Makulerade rader filtreras bort även i detaljvyn; helt makulerade originalbongar döljs. Deras annulleringsbongar och orsaker finns kvar.
- Bongdialogen erbjuder endast nästa servergodkända statussteg. Den kontrollerar att det visade underlaget inte har ändrats innan status skickas. Statusnamn som `queued` och `void` visas på svenska i arbetsvyerna.
- Öppna dialoger stängs vid utgången session och vid byte till anslutningsskärmen. Provet öppnar en artikeldialog, låter testservern avsluta sessionen, kontrollerar att dialogen försvinner och loggar in igen.
- Ett gränsfall där ett mycket stort kronorbelopp plus ören kunde överflöda heltalet rättades. För stora värden avvisas före sändning.
- **Dela nota** öppnar betalningsdialogen med **Dela lika** valt. Slutprovet betalade 100,01 kr som 33,34 + 33,34 + 33,33 kr och kontrollerade tre betalningar, exakt totalsumma och avslutad nota.

Verifiering av slutlig kod: **29 JVM-tester**, 0 fel; **Android Lint 0 fel, 23 varningar**; optimerad APK och osignerad release byggda; native-serverns TypeScript-kontroll och **2 regressionstester** passerade. Serverproven täcker även delning per gäst, rader och antal, dubbel anropsnyckel, för stort artikelantal, redan betald gäst samt gammal notversion utan ny betalning.

`BugReviewTest` och befintliga `UnpaidTabsTest` kördes mot en separat server med enbart databas i minnet. Slutlig APK gav **OK (2 tests), 152,417 sekunder** i en separat Android 35-emulator, 720 × 1280 px / 320 dpi (360 dp bred), 2 virtuella processorkärnor och 1 536 MB gäst-RAM. Tidigare nottest kontrollerade dessutom obetalda notor, borttagning, minus, omstart, nummer/karta och väntande rätter. [Slutlig instrumenteringslogg](docs/native-v111-test-results.txt).

Ett tidigare BlueStacks-prov av konflikt/kök/delning passerade i bred layout. Ett senare försök på smal BlueStacks avbröts därför att en annan app tog förgrunden; det räknas inte som ett godkänt prov. Därför användes den separata emulatorn för slutverifieringen. BlueStacks ordinarie skärmstorlek återställdes. Ingen appdata rensades och de befintliga native-demodatabaserna användes inte för provbetalningarna.

Ingen ny FPS-mätning eller provning på fysisk handterminal ingår i denna buggfix. Automatisk skickning till köket är inte införd.

Test-fixturen `server/review-fixture.ts` startas uttryckligen, binder endast `127.0.0.1:4202` och använder `:memory:`. Den ingår inte i den vanliga native-serverstarten. Bygg den separat med esbuild till `artifacts/native-server/review-fixture.mjs` med `--bundle --platform=node --format=esm --packages=external`, starta den med Node 24 och kör `se.restaurant.nativepos.smoke.BugReviewTest` med instrumenteringsargumentet `server` satt till testserverns adress. Ingen verklig restaurangdatabas får användas för dessa prov.

## Version 1.1, 2026-10-17

Distribuerad APK: `1.1.0-native-test`, versionCode 2, **234 195 byte**. SHA-256: `3ccefedf9e4930b708d9ecfd94d089fe859e4cb501e50c85a7cbdd4b0948248d`.

- Optimerad test-APK och osignerad release byggda. Installerad test-APK saknar flaggan `DEBUGGABLE`; R8:s kodoptimering är aktiverad. Lokal test-HTTP och diagnostik styrs separat och ändrar inte release-variantens HTTPS-krav.
- **25 JVM-tester passerade**, inklusive bordsnummer med inledande nollor, dubbletter i olika områden, inaktiva bord, återanvändning av öppen nota och beständig försöksnyckel för minus.
- **Android Lint: 0 fel, 23 varningar.** Varningar om bland annat textresurser och lokal testkonfiguration kvarstår.
- Den nya native-serverdelens TypeScript-kontroll och regressionstest passerade. Provet kontrollerar 3→2 med bevarade tillval, pris, moms, gäst och kommentar; samma nyckel efter förlorat svar; konflikt vid ändrad avsikt/version/antal; nekad obehörig eller anonym ändring; betalningslås för pending/unknown/approved; makuleringsbong för exakt en skickad enhet; och full återställning av databas/journal/utskriftskö om bongkontrollen misslyckas.
- Ny produktkod ligger endast i `android-native/`; övrig ändring är dess egen GitHub-workflow. Ordinarie webb- och serverkällor ändras inte.

BlueStacks använder en separat native-server på lokal port 4198 och en separat testdatabas, skapad med SQLite online-backup av den tidigare native-demonstrationen. De tidigare 12 notorna bevarades i kopian; originaldatabasen och originalservern lämnades orörda. De automatiserade provnotorna är träningsdata och medför inga betalningar.

Slutlig APK provades i **BlueStacks/Android 9** med logisk handkasseskärm **360 × 616 dp** (540 × 960 pixlar, 240 dpi). `UnpaidTabsTest` och `HomePerformanceTest` gav tillsammans **OK (2 tests)** på 156,388 sekunder. Den tiden är testkörningens längd, inte ett FPS-resultat. Testet bekräftade startsida utan vald nota, obetalda disknotor, synliga borttagningsknappar, 3→2 utan ny orderrad, appomstart, okänt bordsnummer, samma nota via nummer/karta, större notlista på handkassa samt utslag av en av flera väntande rätter. Notornas betalningslistor förblev tomma. Huvudkassans flöde hade också passerat under 1.1-arbetet; slutlig bred layout kontrollerades visuellt efter att BlueStacks återställts till 1600 × 900.

Det korta mätfönstret innehöll uppvärmd menyskrollning, navigation till startsidan och scrollning av öppna notor. **897 HWUI-bildtider**, median **0,90 ms**, p95 **1,28 ms**, p99 **4,31 ms**, **0 över 16,7 ms**, **0 över 33,3 ms**, **0 tappade mätvärden**. Det håller bildtidsbudgeten för 30/60 fps i detta emulatorprov. Det mäter inte faktisk konstant FPS eller beröringsfördröjning på en betalterminal. Modellsträngen `SM-G998B` kommer från BlueStacks; ingen fysisk Samsung användes. [Rådata](docs/bluestacks-v11-frames.json) och [instrumenteringsresultat](docs/native-v11-test-results.txt) sparas med koden.

Under arbetet avbröts ett prov av BlueStacks UiAutomation vid bildtagning; skärmbilder är därför valfria i nottestet. Ett första prov på den minsta skärmen visade också att den ursprungliga kombinationen av knappsats och notlista blev för trång. Det åtgärdades med den expanderade notlistan före den godkända slutkörningen. Inga sådana misslyckade eller äldre körningar räknas in i slutresultatet ovan.

## Historiskt utfall 1.0, 2026-10-17

Följande äldre resultat avser APK 1.0 med SHA-256 nedan. Den byggvarianten hade `minifyEnabled=true` men också `debuggable=true`, vilket stängde av full kodoptimering i R8. Version 1.1 rättar detta med `debuggable=false`. De gamla mätvärdena är fortfarande observationer av den gamla APK:n; de ska inte presenteras som mätningar av 1.1.

21 JVM-tester och två instrumenterade Android-flöden passerade. Den separata kontrollen av den distribuerade, optimerade APK:n passerade också, inklusive tappat svar, tvångsstängning av hela appen och återhämtning. Android Lint rapporterade 0 fel och 20 varningar (bland annat svenska texter utan översättningsresurser, avsiktlig beständig lagring, lokal test-HTTP, användarinstallerad CA och versionsförslag).

Prestandaprovet kördes i Android-emulator API 35/x86_64, 1 024 MB gäst-RAM, 2 virtuella processorkärnor och värddatorns grafik. Skärmen var 720 × 1280, 320 dpi. Menyn hade 351 artiklar; testservern hade dessutom 40 öppna stressnotor med 25 rader vardera. Mätfönstret omfattade uppvärmd scrollning och ett litet antal omgivande UI-bilder, med första ritningen utesluten. Det är ett kort utvecklingsprov, inte terminalacceptans eller ett långtidstest.

| Mätvärde | Utfall |
| --- | --- |
| Uppmätta bilder | 455 |
| Median | 5,66 ms |
| 95:e percentilen | 18,32 ms |
| 99:e percentilen | 18,75 ms |
| Bilder över 33,3 ms | 0 av 455 |
| Bilder över 16,7 ms | 121 av 455 |
| Tappade mätvärden | 0 |
| Synliga artikelvyer / totalt skapade | 6 / 14 för 351 artiklar |

Detta uppfyller 30-fps-bildbudgeten i just detta mätfönster, men inte 60-fps-budgeten för alla bilder. Det mäter bildtider och är ingen uppmätt konstant FPS på en fysisk handkassa. [Rådata](docs/emulator-frames.json) och [testutfall](docs/test-results.txt) ligger med i grenen.

Testad APK: 694 444 byte, SHA-256 `a3676ee7911c97c7ea5a718f983bb8d6e61735e40b7ef03ff20aab108e6de5a4`.

## Reproducerbara tester

Bygg från `android-native/`:

```sh
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest :app:assembleOptimized :smoke:assembleOptimized :app:testDebugUnitTest :app:lintDebug
```

Bygg servern enligt repots vanliga instruktioner, starta sedan från repots rot:

```sh
node android-native/scripts/test-server.mjs
```

Testservern skapar en ny temporär databas och egna säkerhetskopior. Den använder simulatorer, binder till loopback och kräver att dess egen serverprocess verkligen har startat. Den skickar aldrig tester mot en operatörs angivna kassaserver. Portarna 4196 och 4200 måste vara lediga. En annan byggd server kan väljas med första argumentet (repomapp) och andra argumentet (serverfil relativt repomappen).

Android-emulatorn ansluter till `http://10.0.2.2:4196`. Testerna hämtar enhetskod och produkt från den isolerade servern. Kör endast på en dedikerad testemulator: APK-testet rensar **native-testappens** data och testar tvångsstängning. Den tidigare hybridappens paket rörs inte.

```sh
adb install -r android-native/app/build/outputs/apk/debug/app-debug.apk
adb install -r android-native/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w -r -e class se.restaurant.nativepos.NativeWorkflowTest se.restaurant.nativepos.test.test/androidx.test.runner.AndroidJUnitRunner

adb install -r android-native/app/build/outputs/apk/optimized/app-optimized.apk
adb install -r android-native/smoke/build/outputs/apk/optimized/smoke-optimized.apk
adb shell am instrument -w -r -e class se.restaurant.nativepos.smoke.OptimizedApkTest se.restaurant.nativepos.smoke/androidx.test.runner.AndroidJUnitRunner
```

Kontrollera att resultatet faktiskt innehåller `OK (...)`; Androids instrumenteringskommando kan avslutas med processkod 0 även om ett test misslyckades.

- JVM-tester provar öresavrundning och fördelning, 2 000 slumpade fördelningar, URI-/exportgränser, gamla snapshots samt beständig återhämtning vid tappat svar/lagringsfel. Enhetskod som roteras får inte hanteras som en vanlig upprepningsbar PUT.
- Instrumentering i debug-appen provar riktig inloggning, nota, order, tappat svar efter servercommit, omstart av aktivitet, samma idempotensnyckel och exakt två artiklar, utslag och träningsbetalning. Stresstest: 300 extra artiklar, 40 notor med 25 rader vardera, scrollning och sökning; antalet skapade/synliga rader måste vara begränsat.
- Den separata `smoke`-modulen provar den faktiska R8-APK:n utifrån via Android UI Automator. Den länkar inte mot appens interna klasser eller lägger in testbibliotek i appen. Den provar installation, anslutning, köpflöde, tappat svar, tvångsstängning av hela processen, återhämtning, betalning, scrollning och huvudkasselayout.
- GitHub Actions bygger APK och osignerad release, kör JVM-tester/Lint och bygger Android-testpaketen. Emulatorflödena ovan körs lokalt; CI-jobbet påstår inte att det har kört dem.

### Obetalda disknotor, verifierat 2026-10-17

Samma distribuerade APK (SHA-256 ovan) provades separat i Android 35-emulatorn med 1 GB RAM och två processorkärnor. `UnpaidTabsTest` gav **OK (1 test)** på 51,509 sekunder. Ingen appkod eller APK ändrades för denna kontroll.

- Två disknotor skapades via Android-gränssnittet med en Cola vardera. Byte till en ny/annan nota krävde ingen betalning.
- En oskickad rad togs bort. Efter ett nytt tillägg och utskick togs även den skickade raden bort som **Ansvarig**.
- Den andra notans artikel påverkades inte. Den första notan fylldes på igen och hämtades fram från **Bord**.
- Hela appens process tvångsstängdes och startades igen. Båda notorna var fortfarande öppna, artikelraden gick att visa och servern innehöll noll betalningar.
- Ett separat API-prov bekräftade att **Servering** får ta bort oskickade/väntande rader, nekas borttagning av en skickad rad, och att **Ansvarig** kan makulera den skickade raden med makuleringsbong.

Testdata sparades i en egen beständig träningsdatabas. Omstart av själva serverprocessen genomfördes inte i denna kontroll och räknas inte som verifierad. Detta var ett funktionstest; det ger inget nytt FPS-resultat.

Samma APK och nottest godkändes även i **BlueStacks, Android 9**, den 2026-10-17: **OK (1 test)** på 34,305 sekunder. Där provades den breda huvudkasselayouten. Appen anslöts till samma separata träningsserver via `adb reverse tcp:4196 tcp:4196` och testargumentet `server=http://127.0.0.1:4196`. Native-appen och den tidigare hybridappen var installerade som separata paket. Android Studios emulator var stängd under BlueStacks-provet. Tiden är testets körtid, inte en FPS-mätning.

Kör på en dedikerad emulator som anslutits till samma isolerade träningsserver. Anpassa enhetskoden till serverns testkod:

```sh
adb shell am instrument -w -r -e class se.restaurant.nativepos.smoke.UnpaidTabsTest -e server http://10.0.2.2:4196 -e deviceCode LAGUSTOSA-TEST se.restaurant.nativepos.smoke/androidx.test.runner.AndroidJUnitRunner
```

## Terminalprov före pilot

Använd exakt terminalmodell, OS/WebView-oberoende firmware och nätverk som leverantören avser godkänna. Mät en produktionslikt signerad optimerad APK utan ansluten debugger. Dokumentera modell, Android-version, RAM, skärmupplösning/Hz, appversion, serverversion och antal artiklar/notor.

1. Kör efter kallstart och efter uppvärmning: 300–1 000 artiklar, 40–100 öppna notor, artikelval, tillval, kategori-/notabyte och snabb scrollning.
2. Mät minst 60 sekunder per aktivt scenario, upprepat tre gånger. Kontrollera att minst 95 % av bildtiderna håller budgeten 33,3 ms för 30 fps; använd 16,7 ms för 60 fps-målet. Kontrollera även p99 och tappade mätvärden. Räkna inte stillastående skärm som 60 fps.
3. Prova två kassaenheter samtidigt, stora notor, flera delbetalningar, artikelreturer, kvitto och dagsavslut. Registrering/betalning ska vara enkel och konsekvent även när servern är långsam.
4. Bryt nätverket före/efter servercommit, under betalning och kontrollkod. Tvångsstäng appen och starta om terminalen. Kontrollera samma försök/nyckel, inga dubletter och ingen ny betalning medan utfallet är osäkert.
5. Kör ett längre restaurangpass med laddning, verklig skrivare och leverantörens betalapp. Följ värme, minne, batteri och bildtider efter uppvärmning.

Ingen fysisk Worldline-/Swedbank Pay-terminal eller Samsung har varit ansluten under utvecklingstestet. Godkänd emulatorverifiering är därför inte ett löfte om en viss FPS på dessa enheter.
