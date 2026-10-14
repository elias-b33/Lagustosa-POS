# Lagustosa Kassa

Restaurangens egen lokala webbapp för huvudkassa, bordsservering, kök och bar. Servern körs på en Windows-laptop; personalens enheter använder webbläsaren.

**Den här versionen är en träningskassa.** Standardmiljön använder lokala simulatorer. En separat Softpay Cloud-koppling för sandbox finns, verifierad med lokala kontraktstester; externt prov med utvecklarkonto och Android-enhet återstår. Kontrollenhet och skrivare är fortfarande simulator/förhandsvisning. Gränssnitt, kvitton och rapporter är märkta `TEST — inga riktiga betalningar`. Produktionsläge är spärrat i servern.

En närmare integrationsbeskrivning, startbart lokalt handterminaldemo och instruktioner för leverantörens testmiljö finns i [PAYMENT-INTEGRATION.md](PAYMENT-INTEGRATION.md). Demot kan startas med `npm run demo:softpay` efter bygge och öppnas på port 4793.

### Status inför verklig försäljning — kontrollerad 13 oktober 2026

Denna implementation är **inte verifierad och tillverkardeklarerad för skarp kassaregisterdrift**. En fungerande betalningsknapp, gröna programtester eller en ansluten kortterminal ersätter inte kraven för kassaregistret.

Skatteverkets normala modell är ett tillverkardeklarerat kassaregister tillsammans med en certifierad kontrollenhet eller ett certifierat kontrollsystem. Tillverkaren ansvarar för att föreskrifterna uppfylls och för dokumenterade tester; Skatteverket gör inte en egen produktprovning. Den version och kontrollenhetskombination som används måste omfattas av underlaget. Se [kraven på certifierat kassaregister](https://www4.skatteverket.se/rattsligvagledning/edition/2026.7/339826.html) och [informationen för tillverkare](https://www.skatteverket.se/foretag/drivaforetag/kassaregister/fortillverkareochleverantorer.4.6efe6285127ab4f1d2580006050.html).

| Område | Status i projektet | Återstår före verklig kassaförsäljning |
|---|---|---|
| Kontrollenhet/kontrollsystem | Simulator | Välja certifierad lösning, implementera och verifiera kopplingen |
| Kassaregistrets föreskriftskrav | Förstärkt träningsjournal, kvitton och rapporter | Fullständig kravtäckning per registreringsenhet, testprotokoll för verklig integration, versionsidentifiering och tillverkardeklaration |
| Journal-XML | Träningsimplementation med automatiska tester mot officiellt XSD | Fullständig semantisk täckning, samtliga gränsfall och verklig kontrollösning; schemavalidering är inte ett efterlevnadsintyg |
| Installation | Lokala testomgångar | Anmäla kassaregister och kontrollenhet/kontrollsystem för företaget |
| Betalning och utskrift | Lokal simulator samt Softpay Cloud sandbox-adapter; utskriftsförhandsvisning | Externt sandboxprov, Android-appväxling, återstående betalningsfunktioner, fysisk utrustning och verifierade fel-/återställningsflöden |
| Tillgänglighet | Tester, databaslås och mätverktyg | Installation, mätning under öppettider, återställningsövning och reservrutiner |

Från **1 januari 2027** ska kassaregister uppfylla SKVFS 2021:17; journalminnen ska kunna exportera registreringar i XML. Att appen kan generera en XML-fil är inte bevis på att hela kravet uppfylls. [Skatteverkets aktuella information](https://www.skatteverket.se/foretag/drivaforetag/kassaregister). Installationen ska anmälas innan användning: [så anmäler du kassaregister](https://www.skatteverket.se/foretag/drivaforetag/kassaregister/saharanmalerdukassaregister.4.69ef368911e1304a62580008748.html).

Övergången avser användning av vissa äldre kassor. Den innebär inte att en nyutvecklad produkt kan skjuta upp dagens tillverkarkrav till 2027. Enligt 8 kap. 4 § ska tillverkardeklaration och utdrag ur testprotokoll skickas **senast två veckor före tillhandahållande av modellen/programmet på den svenska marknaden**. Själva deklarationen ska ingå i produktens dokumentation; reglerade versionsändringar kräver ny bedömning och i tillämpliga fall ny deklaration. [SKVFS 2021:17 med övergångsbestämmelser](https://www4.skatteverket.se/download/18.566df4d617d171254ec3e41/1698824220274/SKVFS%202021_17.pdf).

Behåll ordinarie kassaregister för kundförsäljning medan denna app provas med testnotor. Ingen deklaration eller myndighetsanmälan har skickats från projektet.

### Kravgranskning och återstående hinder

Granskningen avser en svensk restaurang med normal kassaregisterskyldighet. Något undantagsbeslut har inte visats för projektet. Betalning med Swish omfattas också av kassaregisterreglerna; en kortterminal eller en betalningsbekräftelse ersätter inte ett kassaregister. [Skatteverkets översikt](https://www.skatteverket.se/foretag/drivaforetag/kassaregister).

Följande förbättringar ingår i träningsprogrammet. De är avgränsade programkontroller, inte en tillverkardeklaration:

- Huvudkassan och de fyra säljande enheterna har permanenta kassaidentiteter samt egna kvitto- och Z-rapportserier. De tre orderskärmarna har ingen försäljningsidentitet. Namnbyte, ny enhetskod och serveromstart behåller identiteten. Äldre gemensam historik flyttas inte till nya kassor. Betalningens ursprungliga kassa och kassör följer med även när ett osäkert svar kontrolleras från en annan enhet.
- Betalning och retur stöder valda artiklar och antal samt valda kvittorader. Antal, rabatt, brutto och moms avräknas mot kvarvarande underlag, inklusive osäkra reservationer. Exakta rationella andelar bevaras vid beloppsdelning och visas som ekonomiska andelar. Gratisrader och avrundade nollbelopp behåller sina antal. Äldre kvitton utan antal får inga påhittade historiska uppgifter.
- En gästkvittokopia kan bara skapas en gång per original, även när flera enheter försöker samtidigt. Kopiering av kopian avvisas. Kökets och barens bongar har separat återutskriftslogik. Den fysiska kvittotypografin och överföringen av kopior till kontrollösningen återstår.
- Dagsavslut sparar separata rapporter per kassa med identitet, tid, nummer och träningsräknare. Rapporter byggs från journalens ögonblicksbilder och journalnummer; senare ändringar eller tillbakaflyttad systemklocka ändrar inte tidigare underlag. Försäljning/retur, moms, varugrupp, betalmedel, rabatt, rättelser, kopior, lådöppningar, kontanthändelser och antal redovisas. Vara/tjänst anges separat för servering och avhämtning i menyn och sparas i nya orderrader. Okänd historisk klassificering markeras.
- XML-exporten har ett granskningsbart underlag per datum och kassa. Ekonomiska händelser som inte kan återges korrekt spärrar exporten med en förklaring. Tekniska händelser och historiska luckor redovisas uttryckligen; JSON bevarar originalposter, hashvärden och refererade originalkvitton.
- Kontantinsättningar och uttag registreras vid huvudkassan med belopp, orsak, ansvarig och en bestämd verksamhetsdag. De påverkar förväntad kontantkassa utan att räknas som försäljning. Ett sparat försök behåller sin identifierare vid förlorat svar så att en omkontroll inte registrerar beloppet igen.
- Databasregler skyddar kvittots innehåll, bekräftade kontrolluppgifter, avslutade dagar och journal mot omskrivning och radering via appens databasanslutning. Journalens hashkedja kontrolleras före serverstart. Dessa kontroller skyddar inte mot någon som har full kontroll över databasfilen eller operativsystemet; separat skyddad arkivering återstår.
- Företagsuppgifter och kassabeteckning är låsta under en öppen verksamhetsdag. Inställningsändringar journalför både tidigare och nya värden. Momsdatum valideras utan att ogiltiga kalenderdatum blir serverfel.
- Produktionsspärren gäller även när API-servern skapas direkt. Miljövariabler kan inte slå på riktig betalning, fysisk utskrift eller en verklig kontrollenhet i denna version.

**Kvarstående hinder före skarp drift:**

| ID | Hinder | Konkret underlag som krävs för att stänga punkten |
|---|---|---|
| L01 | Endast simulerad kontrollösning | Valt certifierat fabrikat/version, leverantörens protokoll och testmiljö, implementerad överföring och prov av avbrott/återhämtning. Försäljning, retur, kopia och övningskvitto måste ingå. |
| L02 | Separata kassaidentiteter och serier finns nu i träningsmodellen | Verifiera registreringsenheter, kvittoserier, journalurval och kontrollregistrering mot den valda certifierade lösningen. Äldre gemensam historik måste fortsatt kunna identifieras som äldre. |
| L03 | Exakta artikelantal och avgränsade returer finns; beloppsandelar behöver fiskal verifiering | Fastställ godtagbar produktionsmodell för godtycklig beloppsdelning och de antal som kontrollösning och XML kan återge. Exempelvis 1/3 kan inte skrivas exakt i schemats två decimaler. |
| L04 | X/Z-underlag per kassa finns; skarpa räknare är inte implementerade | Kravvis slutprovning av alla uppgifter och räknare, vald varu-/tjänstklassificering samt verklig kontrollösning. Träningsräknare får inte konverteras till verklig omsättning. |
| L05 | XML granskas och spärras vid kända luckor | Slutlig mappning av bland annat övningskvittokopior, negativa träningssaldon och andelar över två decimaler. Äldre saknat underlag får inte gissas. JSON ersätter inte föreskriven XML. |
| L06 | Ingen färdig tillverkardeklaration | Identifierad ansvarig tillverkare, modell/programversion, funktionsdokumentation, kravmatris, testprotokoll med vald certifierad kontrollösning och korrekt deklaration till Skatteverket. Reglerade versionsändringar behöver följas upp. |
| L07 | Ingen anmäld skarp installation | Verifierade företagsuppgifter, lokal och identifierare för varje anmälningspliktig registreringsenhet och kontrollösning samt företagets anmälan före användning. |
| L08 | Ingen verklig betalnings- eller skrivardrift | Inlösar-/betalningsavtal, leverantörens godkända integration, fysisk terminalprovning, korrekt kvitto på valda skrivare och säker hantering av osäkra svar. PCI-ansvaret måste fastställas med leverantören. |
| L09 | Konton/roller och verifierbar backup/återläsning finns; skyddat arkiv saknas | Konfigurera personliga konton i den verkliga installationen, separat skyddad lagring, bevarandeplan, driftansvar och dataskyddsrutiner. Manifest och lokal hashkedja ersätter inte skydd mot en angripare som kan ändra både databas och kontrollfiler. |

L02 är ett arkitekturkrav, inte bara en nätverksinställning. Skatteverkets vägledning behandlar funktioner per registreringsenhet (4 kap. 2 §), åtskillnad för tunna klienter (5 kap. 3 §), kontrollregistrering (5 kap. 7 §) samt kvitton och rapporter (7 kap. SKVFS 2021:17). [Krav på kassaregister och tillverkardeklaration](https://www4.skatteverket.se/rattsligvagledning/edition/2026.14/339829.html). De tre skrivarna är utmatningsenheter; att lägga till skrivarprofiler löser inte kraven för de fem enheter som kan avsluta en försäljning.

Nästa externa steg är att inhämta en certifierad kontrollösnings integrationsunderlag och välja betalningsleverantörens testmiljö. Ingen leverantör är vald och inga tjänster är köpta. Därefter behöver tillverkaren och restaurangen granska underlaget och sina respektive skyldigheter innan produktionsspärren ens övervägs. Skatteverket produktgodkänner inte programmet genom våra tester: [tillverkarens ansvar och deklarationsförfarande](https://www.skatteverket.se/foretag/drivaforetag/kassaregister/fortillverkareochleverantorer.4.6efe6285127ab4f1d2580006050.html).

### Inför kommersiell distribution

Att sälja programmet medför även produkt-, licens- och dataskyddsfrågor. Identifiera juridisk tillverkare, modell/version och rättigheter till kod, namn, logotyp och annat material. La Gustosas logotyp kommer från restaurangens webbplats; detta dokumenterar inte rätt att använda den i en produkt för andra kunder. Ett utvecklings-/testavtal måste beskriva den faktiska ofärdiga leveransen och gör inte programmet färdigt för skarp kassaförsäljning.

Nuvarande Windows-paket med lokal nätverksserver talar för en produkt som omfattas av EU:s cyberresiliensförordning (CRA) när den tillhandahålls kommersiellt. Ren SaaS och nödvändig fjärrdatabehandling kräver en bedömning av den verkliga lösningen. **Artikel 14 om rapportering gäller från 11 september 2026**, även för berörda produkter utsläppta före huvudreglernas datum. Huvudreglerna gäller från **11 december 2027**, med övergångsregler för tidigare utsläppta produkter och väsentliga ändringar. Versionsbundet underlag för risker, komponenter, säkerhetsuppdateringar, incidentrapportering och tillämplig bedömning av överensstämmelse behövs. CRA:s EU-försäkran och CE-märkning är separata från Skatteverkets tillverkardeklaration. [CRA](https://eur-lex.europa.eu/eli/reg/2024/2847/oj), [kommissionens antagna vägledning från juli 2026](https://digital-strategy.ec.europa.eu/en/library/commission-publishes-new-guidance-support-timely-cyber-resilience-act-implementation), [rapporteringsskyldigheter](https://digital-strategy.ec.europa.eu/en/policies/cra-reporting).

Personuppgiftsbiträdesavtal behövs när leverantören behandlar kundens personuppgifter på kundens uppdrag, exempelvis genom drift, hanterad backup eller support med sådan behandling. En ren lokal licens utan sådan behandling skapar inte automatiskt en biträdesroll. Roller, behandlingsländer, underbiträden, säkerhet, lagring och export vid avtalets slut ska dokumenteras utifrån faktisk leverans. [IMY om personuppgiftsbiträdesavtal](https://www.imy.se/verksamhet/dataskydd/det-har-galler-enligt-gdpr/personuppgiftsansvariga-och-personuppgiftsbitraden/personuppgiftsbitradesavtal/).

### Bokföring, dataskydd och restaurangens rutiner

Räkenskapsinformation ska normalt bevaras i sju år efter kalenderåret då räkenskapsåret avslutades. En backup på samma dator uppfyller inte i sig kraven på en fungerande arkivlösning. Restaurangen och redovisningsansvarig behöver bestämma vad som utgör räkenskapsinformation, var det förvaras och hur läsbarhet och återställning säkras under hela tiden. [Bokföringsnämndens arkiveringsvägledning](https://www.bfn.se/fragor-och-svar/arkivering/).

Personalnamn, inloggnings- och aktivitetsloggar samt eventuella personuppgifter i anteckningar omfattas av dataskyddsbedömningen. Testkonton med gemensamma PIN-koder är avsedda för provning. Före verklig användning krävs individuella behörigheter, definierade ändamål och rättslig grund, information till berörda, lagringstider och hantering av rättighetsbegäranden. Uppgifter som måste sparas för bokföring ska hanteras med lämpligt avskild åtkomst. Ingen automatisk gallring av journalen är införd; behovet av bevarande och gallring måste beslutas tillsammans. Undvik kundnamn, kortuppgifter och identifierbara hälsouppgifter i testanteckningar. [IMY:s grundläggande principer](https://www.imy.se/verksamhet/dataskydd/det-har-galler-enligt-gdpr/grundlaggande-principer/), [behörighetsstyrning](https://www.imy.se/verksamhet/dataskydd/det-har-galler-enligt-gdpr/informationssakerhet/behorighetsstyrning/).

Kortintegrationens PCI DSS-omfattning bestäms av den faktiska lösningen och avtalen. Att terminalen är separat innebär inte automatiskt att restaurangen saknar ansvar. Den nuvarande simulatorn skickar inga riktiga korttransaktioner. [PCI SSC om betalterminaler](https://www.pcisecuritystandards.org/faqs/1300/).

Personalvyn i appen är ett behörighetsregister. Den är inte en personalliggare. Restaurangens skyldigheter kring personalliggare och övrig verksamhetsdrift behöver fortsatt hanteras utanför denna träningsapp. [Skatteverkets regler om personalliggare](https://www4.skatteverket.se/rattsligvagledning/edition/2026.14/340631.html).

## Säker provkörning

Dubbelklicka på **Start-Testmiljo.cmd** för att öppna **http://127.0.0.1:4273/**. Den här starten använder en separat databas under `%LOCALAPPDATA%\LagustosaPOS\safe-test\sessions\`, en separat inloggningscookie och tvingade simulatorer. Startverktyget verifierar rätt server innan webbläsaren öppnas. Utvecklingsdata bevaras.

**Stoppa-Testmiljo.cmd** stoppar testservern. **Ny-Testomgang.cmd** börjar en ny tom testomgång och sparar de tidigare. Startverktyget fungerar även i Windows-paketet med medföljande Node, utan npm-installation. Läs [TEST-GUIDE.md](TEST-GUIDE.md) för första restaurangscenariot, alla åtta enhetsprofiler och HTTPS på testplattor.

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

Testkoderna visas även under **Enhet och testprofiler** på inloggningssidan. Dessa är avsedda för träning. Meny, bord, personal och enheter kan ändras i **Inställningar**. Bordsplaceringen är exempeldata.

## Restaurangens meny

Matmenyn följer PDF:en **La-Gustosa-meny-Cotto-Terrakotta.pdf**: 47 rätter i nio kategorier, med namn, beskrivningar och priser i dokumentets ordning. Antipasto della casa har de obligatoriska storlekarna Piccolo (139 kr), Medio (255 kr) och Grande (399 kr). Pollo alla griglia och Filetto di manzo har val av inkluderat tillbehör och sås; oxfilén kräver också stekning.

PDF:en innehåller inga dryckespriser. De fyra förberedda dryckesartiklarna behåller därför sina exempelpriser och visas med **Testpris** i kassan. Dokumentet anger inga särskilda avhämtningspriser eller verifierade allergenlistor; dessa har inte lagts till.

Vid första starten med denna version uppdateras matartiklarna i en transaktion och den föregående menyn arkiveras i databasen. Befintliga orderrader, bongar, betalningar och kvitton behåller sina sparade uppgifter och belopp. Egna artiklar och drycker bevaras. Senare ändringar i **Inställningar → Meny** skrivs inte över vid omstart. Källans filnamn och SHA-256 sparas med importen; själva PDF:en ingår inte i Windows-paketet.

## Välj utseende

Välj **Utseende → Cotto / Professionell / Klassisk** i sidhuvudet eller på inloggningssidan. Bytet sker direkt utan att ändra notor, betalningar eller vald arbetsvy. Valet sparas i webbläsaren och synkroniseras mellan öppna flikar på samma adress. Nya webbläsare öppnar Cotto; ett tidigare aktivt val av Professionell eller Klassisk respekteras.

Det klassiska utseendets `web/styles.css` och `web/tokens.css` är bevarade. Den professionella designen ligger separat i `web/styles-professional.css`. Cotto ligger i `web/styles-cotto.css` och `web/styles-cotto-operations.css`, med varm pappersbakgrund, terrakotta, tydligare menykategorier och en kompakt nota. Git-taggarna `ui-classic-v1` och `ui-professional-v1` bevarar de tidigare versionerna.

Cotto utgår från restaurangens meny och studier av [Lightspeeds registervy](https://k-series-support.lightspeedhq.com/hc/en-us/articles/360050328394-Understanding-the-Register-screen), [Toasts Open View](https://support.toasttab.com/en/article/Get-Started-Open-View) och [TouchBistros bordsarbete](https://www.touchbistro.com/features/tableside-order-management/). Vi använder fasta kategorier, lättlästa priser, synliga obligatoriska val och en tillgänglig nota under beställning. Utformningen och tillgångarna är våra egna. IBM Plex Sans levereras lokalt, utan typsnittsanrop till externa servrar; licensen finns i `web/assets/fonts/OFL.txt` och följer den byggda appen under `/licenses/ibm-plex-sans-OFL.txt`.

Den professionella designens lokala logotyp kommer från [Lagustosas egen webbplats](https://www.lagustosa.se/). Färgerna bygger på restaurangens salviafärgade interiör, mörka ramar och vinröda detaljer. Meny, aktuell nota och stationernas status har tydliga hierarkier för restaurangservice. Logotyp och typsnitt kräver ingen Internetanslutning när appen körs.

## Det som går att prova

- Bord och disknotor, försäljning på plats eller avhämtning, gäster, tillval och köksanteckningar.
- Separata köks- och barbongar, väntande huvudrätter och framkallning.
- Flytt av bord med uppdaterad information till stationerna.
- Delning per gäst, artikel, delbelopp eller lika delar, samt separat dricks.
- Godkänd, nekad, avbruten och okänd betalning; återhämtning av samma försök efter förlorat svar eller omladdning.
- Returer till samma simulerade betalsätt, bevarade originalkvitton och journal.
- Utskriftsförhandsvisning med misslyckad/osäker status och märkt återutskrift.
- Växelkassa, kontantavstämning, dagsavslut, CSV och journal-XML för träning.
- Insättningar och uttag under **Dagsöversikt → Insättning eller uttag**, med orsak och sparat försök vid avbrott. Funktionen registrerar träningsbelopp; den öppnar ingen fysisk kassalåda.
- Roller, PIN-koder, enhetsregistrering och datumstyrda momsregler.

## Ett komplett träningsscenario

1. Logga in som Ansvarig och öppna dagen med 1 500 kr växelkassa.
2. Öppna Bord 01 för två gäster. Lägg Vitlöksbröd och Penne manzo e peperoncino på gäst 1 samt Husets röda på gäst 2.
3. Skicka till kök och bar. Kontrollera respektive station: huvudrätten ska fortfarande vänta.
4. Återgå till kassan och välj **Fram huvudrätt**.
5. Öppna **Ta betalt → Dela lika**. Prova först en nekad betalning.
6. Välj förlorat betalningssvar. Kontrollera samma försök tills dess verkliga simulerade status visas.
7. Prova ett förlorat kontrollenhetssvar och verifiera befintlig registrering. Slutför resterande delbetalning och visa testkvittot.
8. Stäng dagen, kontrollera avstämning och rapport per kassa. Hämta CSV, registerrapport och journalunderlag; läs XML-kontrollens eventuella spärrorsaker.

Betalnings- och returförsök sparas i webbläsaren innan anropet skickas. Om anslutningen bryts kan dialogen stängas och sidan laddas om. En avisering med **Återuppta betalning** eller **Återuppta retur** öppnar det sparade försöket för samma personal och enhet. Belopp och övriga uppgifter är låsta tills resultatet har kontrollerats. Servern söks först efter den befintliga registreringen; endast ett försök som ännu inte registrerats skickas igen, med samma identifierare.

En godkänd registrering visas även om hela notan redan är betald. En okänd registrering kontrolleras eller avbryts innan ett nytt försök kan göras. Om webbläsaren inte kan spara försöket stoppas anropet med ett meddelande i dialogen.

## Tester och byggd version

Tester av journalens XML använder Python 3.12 eller senare och `lxml`. Installera testberoendet en gång; själva kassan behöver inte Python:

```powershell
python -m pip install -r scripts/requirements-test.txt
```

XSD-filerna under `vendor/skatteverket/` är oförändrade från Skatteverkets publicerade schema. Provningen granskar exporter med försäljning i övningsläge, returer, artikeländringar och dagsrapporter. En XML-fil kan även kontrolleras med `python scripts/validate-journal-xml.py "sökväg-till-journal.xml"`. Strukturellt giltig XML innebär inte att alla föreskriftskrav är täckta.

Administratören kan hämta `/api/v1/journal.json` som kompletterande journalunderlag med fullständiga originalposter och hashkedjans gränser. `/api/v1/journal/coverage` visar mappade, tekniska och blockerande poster innan export. Datum- och kassaurval kan anges med `?from=2026-10-13&to=2026-10-13&registerId=KASSANS-ID` på alla tre journalvägarna. En filtrerad JSON anger luckor mellan originalhasharna; den påstår inte att urvalet är en ny obruten hashkedja. Exportkassans identitet hålls åtskild från den valda urvalskassan.

XML avvisar ekonomiska uppgifter som inte kan återges exakt: exempelvis okända äldre antal/varu- eller tjänsteklasser, andelar över två decimaler, kvittokopior utan verifierad kontrollmappning och negativa träningsnetton som strider mot schemats beloppsbegränsning. Långa eller otillåtna textvärden avvisas också. `fullComplianceVerified` är alltid `false`; en lyckad export är inget juridiskt efterlevnadsintyg. Bevara originaldatabasen och JSON för utredning.

Rapporter per kassa kan hämtas med `/api/v1/business-days/DAGENS-ID/register-reports.json`, med valfritt `?registerId=KASSANS-ID`. Öppen dag ger journalfört X-underlag; avslutad dag ger de låsta Z-snapshots som sparades vid avslutet. `coverage.complete` avser bara det underlag som beräkningen använder. Parkerade notor hör till kassan där de öppnades; en betalning hör till kassan som startade betalningsförsöket. Explicit överföring av parkeringsansvar mellan kassor återstår.

`grandTotals.training` är en separat träningsmodell som ackumulerar registrerade kvitton och returkvitton, inklusive moms och efterhandsrättelser av avslutade köp, men exklusive dricks. En kopia, växelkassa eller rättelse innan notan avslutas räknas inte som ytterligare försäljning/retur. Räknarna hålls åtskilda från ackumulerade betalningsbelopp och från `grandTotals.real`, som är noll. Äldre saknat underlag och osäkra kontrollregistreringar markeras i räknarens egen `coverage`. Den verkliga fiskala implementationen återstår.

```powershell
npm test
npm run build
npm run test:safe-env
npx playwright install chromium
npm run test:e2e
```

Vitest verifierar belopp, datumstyrd moms, samtidiga order, delbetalningar, returer, sparade betalningsförsök, skrivarroutning, åtta anslutna SSE-klienter med rätt order/station, omstart, backup och TLS-kedja. Playwright provar restaurangflödet i webbläsaren, två samtidiga servitörer, alla tre utseenden, handterminalens notaflöde, enhetsstatus, skrivarbyte och förlorade svar före och efter registrering av betalning/retur. Browser-tester använder en separat tillfällig databas på port 4183.

Regressionssviterna omfattar även kontinuerlig ordertrafik, gamla inloggningssvar, 15 sekunders timeout inklusive svarskroppen, beloppsgränser efter pris-/rabattändringar samt hård processavslutning och omstart. En okänd betalning behåller samma identifierare; timeout medför ingen automatisk ny debitering. Dessa prov säger inget om bankernas eller den fysiska utrustningens tillgänglighet.

GitHub Actions kör tester och bygge på Windows och Linux. Testbilder sparas lokalt i `artifacts/`; de är inte versionshanterade.

Den samlade lokala verifieringen den 13 oktober 2026 passerade **165 automatiska tester, 16 webbläsartester, bygge och isoleringsprovet**. Sviterna `compliance-integrity`, `receipt-compliance`, `report-compliance`, `journal-compliance` och `cash-movements` ger spårbara exempel på kontrollerna ovan. `aw-scenario` verifierar den separata belastningsplanen och `license-notices` kontrollerar distributionsnotiser. Nya komprimerade AW-körningar med 36 respektive 90 gäster gav inga oväntade fel och noll kassadifferens. Detta är testresultat för simulatorn, inte ett intyg om hela regelverket eller om 99 % tillgänglighet i restaurangdrift.

För att köra den byggda versionen på datorn:

```powershell
npm run build
npm start
```

Öppna <http://127.0.0.1:4173/>. Stäng servern med Ctrl+C i terminalen. Utvecklingsserver och byggd server ska inte köras samtidigt mot samma databas.

## Lokal installation och plattor

Den planerade uppsättningen är **ny, egen utrustning** som ersätter den hyrda Qpay-utrustningen:

| Antal | Utrustning | Uppgift i systemet |
|---|---|---|
| 1 | Huvudkassa | Öppna/stänga dagen, beställa, betala, returer och kontantavstämning |
| 4 | Beställnings- och kortterminaler | Registrera order och ta betalt vid bordet |
| 3 | iPads | Visa och hantera order i kök/bar; station väljs per enhet |
| 3 | Skrivare | Köksbongar, barbongar samt gästkvitton/dagsavslut |

De åtta kassorna/skärmarna arbetar mot samma lokala server. Testprofilerna har två orderskärmar för köket och en för baren; fördelningen kan ändras. **Inställningar → Enheter** visar öppna skärmanslutningar och senast sedd anslutning. Uppgiften beskriver anslutningen till appen, inte kortterminalens bankanslutning.

**Inställningar → Skrivare** har tre förberedda profiler med utskriftstyp och pappersbredd. Varje köat jobb behåller sin tilldelning. Om en profil stängs av bevaras jobbet i kön; efter att en ersättare har aktiverats kan jobbet tilldelas den i **Utskrifter**, med en journalförd orsak. Ett jobb med osäker utskriftsstatus måste först kontrolleras innan en märkt kopia får skapas. Riktig kommunikation med skrivarna och betalningsleverantören läggs till efter val av nya modeller. Beställningsapp och betalningskoppling måste stödjas av de nya handterminalerna.

På handterminaler och mindre skärmar ger **Visa nota** snabb åtkomst till aktuell order. **Till menyn** återgår till samma menyposition. Tillåtna skicka- och betalningsåtgärder använder samma serverflöde som huvudkassan.

Skrivarprofilerna är ännu ingen fysisk anslutning: de innehåller destination och pappersbredd, men inte IP-adress, USB-port eller modellprotokoll. En tillverkaradapter och en utskriftstjänst behöver kopplas till den beständiga kön. Möjliga vägar för kompatibla modeller är [Epson ePOS](https://download4.epson.biz/sec_pubs/pos/reference_en/technology/epson_epos_sdk.html) eller [Star CloudPRNT](https://star-m.jp/products/s_print/sdk/StarCloudPRNT/manual/en/protocol-guide.html); modellstöd måste verifieras innan utrustning väljs. Två köksskärmar visar samma kö; barens skärm visar en annan station.

En reproducerbar **AW-simulering för 36 eller 90 gäster** finns i `scripts/simulate-aw.mjs`. Den använder en ny, isolerad testomgång med åtta virtuella anslutningar, fyra samtidiga serveringsklienter, tre skrivarrutter och delbetalningar. 90-gästprovet den 13 oktober 2026 passerade med 1 557 HTTP-anrop, 90 betalningar, 90 kvitton, inga oväntade fel och noll kassadifferens. Körningen efter registeruppdelningen tog 5,3 sekunder och verifierade även fem separata Z-rapporter samt ackumulerade kvittobelopp; detta styrker de provade flödena, inte 99 procent tillgänglighet eller fysisk utrustning. Se [testguiden](TEST-GUIDE.md#aw-med-36-eller-90-samtidiga-gäster) för full körning, separat förväntansberäkning och en interaktiv demonstration mitt i rusningen.

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

SQLite-backupen inkluderar bekräftade ändringar även när WAL används. Både servern och CLI-verktyget kontrollerar databasens integritet, databasversion, träningsidentitet och journalens hashkedja. Varje ny kopia får en fil med samma namn och suffixet `.manifest.json`, med filstorlek, SHA-256, journalantal och journalens sista hash. Kopiera **både `.sqlite` och `.manifest.json`** till separat skyddad lagring. Manifestet är en integritetskontroll, inte en digital signatur, kryptering eller ett arkiv med skrivskydd.

Stoppa servern innan återställning:

```powershell
npm run restore -- "E:\Backups\lagustosa-training-EXEMPEL.sqlite"
```

Återställning avvisas medan servern körs. Felaktig fil, journal eller manifest stoppar återläsningen innan den aktiva databasen ersätts. Den tidigare databasen får en verifierad säkerhetskopia. Efter återställning avslutas samtliga gamla inloggningssessioner och en återställningshändelse läggs till i journalen; alla måste logga in igen. Prova rutinen i en separat testinstallation.

Äldre kopior utan manifest kräver ett uttryckligt undantag efter granskning: `npm run restore -- "E:\Backups\aldre.sqlite" --allow-legacy`. Databas och journal kontrolleras fortfarande, och undantaget sparas i återställningsjournalen. Återställning kan förlora registreringar efter kopians tidpunkt; i framtida skarp drift måste kvitton, terminaler och kontrollösning stämmas av före återupptagen försäljning. Träningsverktyget löser inte den leverantörsspecifika avstämningen.

Serverstart och återställning håller ett gemensamt processlås i `training-owner.sqlite` under hela användningen. Operativsystemet släpper låset vid processkrasch. Låsfilen är inte en försäljningsdatabas och ska inte återställas, raderas eller bytas medan någon process använder datamappen. Uppgraderingar kräver att gamla serverprocesser stoppas först; parallell start av äldre PID-baserade versioner och den nya versionen stöds inte.

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

## Tillgänglighetskrav under öppettider

Målet är **minst 99 % under restaurangens öppettider**, utvärderat över en rullande 30-dagarsperiod. Det är ett krav, inte en uppmätt egenskap eller garanti för denna version. Tillgänglig tid ska omfatta att personalen kan registrera en order, se den på rätt station och slutföra betalning med den valda utrustningen. Planerade avbrott under öppettid räknas också som avbrott. Utanför öppettiderna räknas tiden inte in. De faktiska öppettiderna och avvikande dagar behöver registreras för att beräkna hela periodens nämnare.

`Tillgänglighet = 100 × (schemalagd öppettid − avbrott under öppettid) / schemalagd öppettid`.

99 % tillåter en timmes avbrott per 100 öppettimmar. Ett fel som blockerar betalningar räknas som avbrott även om startsidan fortfarande laddar. Saknad mätning är okänd tid och får inte användas som bevis på fungerande drift. En lokal testkörning kan inte verifiera detta mål för kommande restaurangdrift.

`GET /api/v1/health` identifierar den levande processen. `GET /api/v1/ready` läser också databasen och svarar 503 om läsningen misslyckas. Den senare kontrollen intygar **inte** skrivbar disk, journalens fullständiga integritet, personalinloggning, skrivare, kontrollenhet eller bankförbindelse.

Ett läsande mätverktyg kontrollerar databaskontrollen och appens HTML-sida. Kör det från en **annan dator i restaurangens nätverk**, under ett bestämt intervall inom öppettiderna. Exemplet mäter en timme och sparar en ny loggfil:

```powershell
npm run measure:availability -- --url https://SERVERNS-NAMN:4173 --seconds 3600 --output artifacts/availability-skift-1.jsonl
```

Använd serverns verkliga adress och en betrodd certifikatkedja; verktyget kringgår inte TLS-fel. I det paketerade systemet kan samma kommando köras med `runtime\node.exe scripts\measure-availability.mjs` följt av argumenten ovan. Befintliga loggfiler skrivs inte över. Inga inloggningsuppgifter, order eller betalningar skickas. Kontrollen sker normalt var femte sekund med tre sekunders tidsgräns. Kortare avbrott mellan stickproven kan missas.

Loggen har varje observation och en slutrapport över **endast det angivna mätfönstret**. Långa luckor i observationerna räknas som obekräftad tid, inte som lyckade prover. Avbruten körning utan slutrapport kan inte visa hela fönstrets tillgänglighet. HTML-kontrollen verifierar inte JavaScript/CSS, rendering eller faktisk användarinteraktion i webbläsaren. Ett godkänt mätfönster avser webb/API-provet och ersätter inte mätning av hela order- och betalningskedjan eller alla öppettider.

Inför drift behövs fast serverinstallation utanför OneDrive, strömreserv för server/nätverk, kontrollerad automatisk omstart, oberoende övervakning med larm och provad återställning till reservdator. Nuvarande Windows-autostart är valfri, sker vid inloggning och försöker starta om högst tre gånger med en minuts mellanrum. Den upptäcker inte en hängande process och är ingen garanti för 99 %. Inga autostart-, ström- eller nätverksinställningar ändras av mätverktyget. Databasen ska ha en aktiv server; flera samtidiga servrar är inte en reservlösning.

## Teknisk grund och nästa integrationer

React/TypeScript/Vite, Fastify/Node 24 och SQLite (`better-sqlite3`, WAL, FULL synchronous). Servern är källa till alla belopp; pengar lagras som heltalsöre. Orderversioner och betalningsidentifierare skyddar mot förlorade ändringar och dubbel registrering. SSE uppdaterar enheterna med polling som reserv.

Adaptergränssnitten för betalning, kontrollenhet och skrivare finns i `server/adapters.ts`. Riktiga drivrutiner ska implementeras och provas mot valda modeller/leverantörer. Swish-verifieringen i denna version är ett testval, inte en bankintegration. Journal-XML är en träningsimplementation; produktionskrav och verifiering mot Skatteverkets schema ingår i arbetet inför riktig drift.

Före kunddrift återstår aktuell meny och bordsplan, betalningsleverantör, fysiska skrivare och certifierad kontrollenhet, dokumenterade tester och tillverkardeklaration samt registrering av installationen. Qpay kan fortsätta hantera kundförsäljning under provdriften.

Momsreglernas exempel följer Skatteverkets uppgifter om [6 % livsmedelsmoms för hämtmat från 1 april 2026 till 31 december 2027, och 12 % restaurangmoms](https://www.skatteverket.se/omoss/pressochmedia/nyheter/2026/nyheter/livsmedelsmomsensankstill6procent.5.70685bee19c85dd5dd0a3f.html). Läs också [informationen för tillverkare och leverantörer](https://www.skatteverket.se/foretag/drivaforetag/kassaregister/fortillverkareochleverantorer.4.6efe6285127ab4f1d2580006050.html).
