# Eleva Admin

Separat administrationsportal för restaurangens ansvariga. Statistik läses skrivskyddat. Butiksändringar skickas som versionskontrollerade kommandon till den befintliga kassaprocessen. Betalningar, kvittoutskrift och dagsavslut sker i POS.

## Lokalt test

Kräver Node 24 och `npm ci`. Bygg med `npm run admin:build`. Sätt `ADMIN_SOURCE_DB` till den befintliga träningsdatabasens absoluta sökväg och kör `npm run admin:local`. Servern binds endast till `127.0.0.1:5194`. Efter första starten minns den källan. Nästa start kan göras med `Starta-Eleva-Admin.cmd`.

Kontot genereras i `%LOCALAPPDATA%/LagustosaPOS/eleva-admin/inloggning.txt`. Logga in med e-post och lösenord. Konfigurera tvåstegsverifieringen med QR-koden i en autentiseringsapp. För lokal verifiering på utvecklingsdatorn kan `Visa-Admin-kod.cmd` eller `npm run admin:code` visa aktuell testkod. Nyckeln gäller endast den lokala testportalen. Ingen e-post skickas av denna server.

För endast den egna lokala testinstallationen kan `ADMIN_LOCAL_REQUIRE_MFA=false` sättas vid start. Valet sparas i installationens lokala kontofil och gäller även efter omstart. E-post och lösenord krävs fortfarande. Återaktivera med `ADMIN_LOCAL_REQUIRE_MFA=true`. Molnportalens Supabase-inloggning och krav på `aal2` påverkas inte.

`ADMIN_LOCAL_DIR` och `ADMIN_LOCAL_PORT` skapar en separat lokal portal. En befintlig portal får inte automatiskt byta kassadatabas. Den lokala PostgreSQL-repliken kör samma migration, RLS-regler och mottagningstransaktion som molndatabasen. Den lokala inloggningen är en separat testimplementation; produktion använder Supabase Auth. Den lokala servern får inte publiceras eller portvidarebefordras.

Utvecklingsgränssnitt: `npm run admin:dev` på 5193, med API-proxy till lokalservern på 5194. Byggda appen fungerar direkt på 5194.

## Publicera testmiljön

Driftkonton behövs innan dessa steg kan genomföras. Välj **Stockholm / eu-north-1** som Supabase-projektets specifika primärregion. Den inställningen är inte ett intyg om dataskydd eller produktgodkännande.

1. Skapa separata Supabase-projekt för test och framtida produktion. Stäng av självregistrering. Konfigurera godkända redirect-adresser, TOTP, lösenordsregler, begränsning av inloggningsförsök och SMTP för lösenordsåterställning. Granska leverantörsavtal, lagringsrutiner och återställning före verklig kunddrift.
2. Kör `npx supabase link --workdir portal --project-ref PROJECT_REF` och `npx supabase db push --workdir portal`. Migrationen finns i `portal/supabase/migrations`. Ingen migration riktas mot POS-databasen.
3. Sätt `PORTAL_ORIGIN` som Edge Function-secret till den exakta webbplatsadressen. Kör `npx supabase functions deploy admin-api --workdir portal`. Gateway-kontrollen är avstängd eftersom samma funktion har två autentiseringsvägar: användaranrop verifieras med `getUser` och RLS/aal2; synkanrop verifieras med en separat installationsnyckel i PostgreSQL-funktionen. Anonyma publika API-nycklar ger inte läsbehörighet.
4. Kopiera `portal/.env.example` till `portal/.env.local` och fyll endast i projektadressen och publishable/anon-nyckeln som `VITE_`-värden. Lägg aldrig service-role- eller synknycklar i webbläsarens miljövariabler.
5. Kör `npm run admin:build:cloud`, sedan `npx wrangler deploy --config portal/wrangler.jsonc`. Domänen kan inledningsvis vara leverantörens tilldelade adress. Uppdatera Supabase site URL, redirect-listan och `PORTAL_ORIGIN` till exakt denna adress. Webbplatsen ska använda HTTPS.
6. Kör `npm run admin:provision` med skyddade miljövariabler `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_OWNER_EMAIL`, `PORTAL_ORIGIN` och valfritt `ADMIN_RESTAURANT_NAME`. Det skapar restaurang, installation, medlemskap och en inbjudningslänk utan att skicka e-post. Länk och synknyckel skrivs till en privat lokal installationsfil, aldrig till Git. Ägaren öppnar länken, aktiverar TOTP och väljer sedan lösenord på Mitt konto. Statistik kräver alltid tvåstegsverifiering.
7. Starta den separata synkprocessen på kassaservern med `npm run admin:sync`. Sätt `ADMIN_SOURCE_DB`, `ADMIN_SYNC_STATE`, `ADMIN_INSTALLATION_ID`, `ADMIN_INGEST_URL` och `ADMIN_SYNC_TOKEN` enligt installationsfilen. Kör som en övervakad process/tjänst med omstart vid krasch. Synkprocessen använder en skrivskyddad SQLite-anslutning och behöver läsrättighet till databasens WAL-filer samt skrivrättighet endast till sin egen state-mapp.
8. Valfri enhetsstatus: sätt en separat stark `ADMIN_RUNTIME_TOKEN` på POS-servern och synkprocessen. Sätt `ADMIN_RUNTIME_URL` till serverns loopback-adress plus `/api/v1/admin-sync/runtime`. Bryggan är begränsad till loopback och hanterar driftstatus, butikssnapshots och kommandon. Databasens sökvägsfingeravtryck kontrolleras innan ett kommando levereras. Ingen POS-session skapas och inga rapportuttag görs. Utan bryggan fungerar statistik; butiksändringar väntar i kön.

Före publicering ska ett riktigt inbjudningsflöde, lösenordsåterställning, MFA, sessionens utgång, synkning från restaurangen och läsning från ett annat nätverk verifieras. Lokala tester verifierar inte SMTP eller den driftade plattformens konfiguration. Inga externa konton eller betaltjänster skapas av byggkommandona.

## Underlag och tidsgränser

Pengar räknas i hela ören. Godkända betalningar hämtas ur journalens snapshots; slutna kassadagar använder sin journalgräns och stäms av mot det sparade dagsavslutet. Returer följer returens verksamhetsdag. Dricks är separat. Återläsning ändrar varken journal, kvitton eller Z-rapporter.

En delbetalning är ett försäljningskvitto, inte en ny gäst eller ny hel nota. Artikelantal är exakta rationella antal endast där `quantityBasis=items`. Beloppsandelar och äldre ofullständiga rader visas som okänt antal. Artikelns historiska namn/kategori används; dagens meny används aldrig för att fylla luckor. Fristående ordinarie bordsnamn visas, men fria notatexter, produktanteckningar, kunduppgifter överförs inte i statistikflödet. Butikssynkningen överför företagsuppgifter, produktbeskrivningar och personalens namn/roller för administration. PIN-koder, PIN-hashar, parkoder, sessioner och fria orderanteckningar överförs inte.

Perioder väljer kassadatum i `Europe/Stockholm`; flera kassadagar samma datum summeras. Jämförelsen är föregående lika långa datumintervall. Pågående perioder är preliminära. Konto-/driftvyer visar senaste snapshot oberoende av datumfiltret. Underlag äldre än två minuter markeras som fördröjt, vilket inte i sig bevisar att en fysisk enhet är avstängd.

Synkningen skickar endast ändrade dagar. Stora leveranser delas i delar; PostgreSQL gör dem synliga i en transaktion först när alla delar finns. Avbrutna leveranser finns kvar på disk och kan återupptas. Gränsen är 6 MB per enskild dagsammanställning och 8 MB per HTTP-leverans; större dagsunderlag stoppar överföringen med ett fel och kräver en utökad transport innan sådan belastning tas i drift. Statistik som redan synkats finns kvar.

Vid `SOURCE_DIVERGED` ska synkningen stoppas. Radera inte synkpositionen på måfå. Jämför kassans återställda journal med arkiv/backup, återställ saknade registreringar enligt ordinarie rutin och verifiera kedjan. Om en uttryckligen beslutad omsynkning behövs: återkalla installationens gamla nyckel, skapa en ny separat installation och läs in den kontrollerade källan helt. Behåll den gamla repliken tills avstämningen är klar; medlemskap/installation väljs uttryckligen vid en sådan övergång. Återställningen får aldrig addera två installationers belopp till samma statistikvy.

## Verifiering

`npm run admin:check`, `npx vitest run tests/admin-portal.test.ts tests/admin-sync-load.test.ts`, `npx playwright test --config playwright.admin.config.ts` samt projektets befintliga kontroller. Webbläsartester skapar en egen simulerad restaurang och utför inga fysiska utskrifter. SQL-tester kör den faktiska migrationen i PostgreSQL/WASM och växlar databasanvändare/claims för att testa RLS.

Programmet är fortsatt träningsspärrat. Portalens rapportarkiv innehåller läsbara sammanfattningar av redan sparade X-/Z-rapporter. De kan exporteras som JSON men ersätter inte kassans fullständiga journalarkiv eller XML-export.

Leverantörsreferenser: [Supabase regioner](https://supabase.com/docs/guides/platform/regions), [Cloudflare Static Assets och säkerhetshuvuden](https://developers.cloudflare.com/workers/static-assets/headers/).


## Butik och inställningar

- Produkter: skapa, ändra pris/beskrivning/klassning/servering/destination, koppla tillägg och avaktivera. Historiska orderrader, kvitton och rapporter ändras inte.
- Kategorier: namn och sorteringsordning styr katalogen. Globala kategorier grupperar lokala kategorier i Admin; de är inte ett system för flera restaurangers centrala sortiment.
- Tillägg: gemensamma grupper med min/max och alternativpriser. Ändringar förs till kopplade produkters framtida beställningar.
- Kuponger/kampanjer: procent på hela notan, svensk tid, datum, veckodagar, klockslag och valfri gräns för antal notor. Väljs i POS under **Erbjudande**. En rabatt per nota. Användning reserveras när erbjudandet väljs; en makulerad nota frigör reservationen. Återbetalning återställer inte kuponganvändningen. Prisregler per artikel, paketrabatter, automatisk tillämpning och personliga engångskoder ingår inte.
- Lager: heltalsantal färdiga artiklar. Inleverans, inventering, svinn, miniminivå och rörelselista. Avdrag sker exakt en gång när en rad skickas/framkallas. Negativt saldo varnas men stoppar inte serveringen. Betalning, retur eller makulering av skickad mat ändrar inte fysiskt lager. Recept, ingredienser och inköpsorder ingår inte.
- Personal: namn, roll och aktiv status. Nya personer skapas inaktiva; personlig PIN sätts vid huvudkassan. Befintliga PIN-hashar lämnar aldrig kassan.
- Enheter: namn/aktiv status för redan parade enheter. Parning och byte av uppgift sker på plats. Skrivarprofiler: destination, bredd och aktiv status; fysisk nätverkskonfiguration finns lokalt. Bord: namn, område, platser och position.

Ägarrollen `owner` får hantera allt ovan. `editor` får ändra butik/erbjudanden/lager. `viewer` läser endast. Migrationen behåller befintliga molnmedlemmar som `viewer`; en behörig driftansvarig måste uttryckligen tilldela ägarroll. Provisionering av en ny installation ger det inbjudna ägarkontot `owner`. Det lokala testkontot är installationens ägare.

Kommandokön lagras i PostgreSQL. Upprepade leveranser återanvänder samma kommando-id och dess sparade resultat i POS. En gammal version avvisas och måste öppnas igen från den senaste katalogen. Behandlingshistorik visar väntande, genomförd, versionskonflikt eller avvisad. Behörigheter kontrolleras vid köläggning och igen när kommandon hämtas. Installationsnyckeln begränsar leveranser till en restaurang; återkallade nycklar stoppas. API och RLS behåller obligatorisk `aal2` i molnet.

Lokal server kan läsa `bridge.json` i sin privata ADMIN_LOCAL_DIR med `runtimeUrl` och `runtimeToken`. Samma token behöver finnas på den aktiva POS-servern som `ADMIN_RUNTIME_TOKEN`. Filen och nycklar ska aldrig checkas in. Startordning: befintlig POS-process, därefter Admin. Enbart Admin öppnar ingen andra skrivande kassaprocess.

Orderhistorik och rapportarkiv följer statistikens sparade journalgräns. Orderdetaljer beskriver hela beställningen och godkända betalningar; de påstår inte att varje delbetalning sålt hela notans artikelantal. Loggar visar begränsade händelser från kassadagar; råa loggdetaljer och personliga anteckningar ingår inte. Behandlingshistorik omfattar de senaste 100 Admin-kommandona, lagerlistan de senaste 500 rörelserna (50 visas åt gången).

Utökad verifiering: `npx vitest run tests/admin-management.test.ts` testar versionskonflikter, rabattgränser, dubbel leverans, PIN-skydd, lageravdrag, rapportläsning, skrivroller, MFA, andra restauranger, nyckelåterkallelse och borttappad bekräftelse efter processomstart. Webbläsartestet skapar produkt/kupong, inventerar och kontrollerar rapport-/orderdetaljer i en separat testdatabas. Inga fysiska utskrifter görs.
