# Verifiering av native-appen

Serverbas: GitHub-commit `7061d4a1011e67ae85ad86d7e4ee2f31795da5a8`. Android-kodens resultat nedan hör till denna separata native-gren och säger inget om webbklientens prestanda.

## Utfall 2026-10-17

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
