# Eleva POS · Softpay Cloud sandbox

Status 14 oktober 2026: implementerad koppling till Softpays dokumenterade Cloud API v3, verifierad med lokala kontraktstester och webbläsarflöden. **Ingen betalning mot Softpays verkliga sandbox, Android-app eller kortläsare har ännu verifierats.** Utvecklarkonto, klientuppgifter och testenhet saknas. Produktionsdrift är spärrad; kontrollösning och kvittoutskrift är fortsatt simulerade.

## Vad som är implementerat

- Servern hämtar OAuth-token med client credentials och anropar enbart de fasta sandboxvärdarna. Klienthemlighet och access-token når inte webbläsaren, journalen eller kvittot. Omdirigeringar avvisas och HTTP-svar begränsas i storlek.
- Varje säljande enhet kopplas till ett unikt Softpay `appId` och ett förväntat `storeId`. Fem enheter kan arbeta samtidigt; ett oavslutat försök blockerar nya kortköp på samma terminal. Orderskärmar hanterar inga betalningar.
- `POST /v3/api/cloud/transactions` skapar en extern referens. Referensen sparas i databasen **innan** `PUT /v3/api/cloud/transactions/{requestId}` får starta betalningen. Ett förlorat PUT-svar leder till statuskontroll med samma referens. Ingen automatisk upprepning av startanropet görs.
- Startsvaret är bara en kvittens. Godkännande kräver ett GET-resultat med `COMPLETED`, `APPROVED`, transaktions-id, rätt belopp, SEK, transaktionstyp, POS-referens, appId och storeId. Oväntade belopp, dricks, avgifter eller saknade uppgifter lämnar försöket osäkert och reserverat.
- Kassans **Avbryt** kontrollerar först status och använder sedan `/abort`, aldrig `/cancel`. Ett redan godkänt köp behandlas som godkänt. Varken en kvittens på avbrott, ett nätverksfel eller HTTP 404 frigör en skickad betalning; utfallet måste hämtas och kontrolleras. Före den sparade dispatchpunkten kan ett försök avbrytas lokalt eftersom ingen betalnings-PUT har skickats.
- Returer använder en separat `REFUND`-transaktion och kräver testkort vid terminalen. Lokala originalreferenser, artikelantal, moms och överretursskydd följer med. Detta verifierar inte att leverantören kräver samma fysiska kort som vid köpet; det måste kontrolleras i pilot och avtal.
- Handterminalvyn väntar på utfallet, kontrollerar status utan överlappande klientanrop och återupptar kontrollen när sidan blir synlig igen. Efter 60 kontroller pausas automatiken; manuell kontroll finns kvar. Omladdning återanvänder det sparade betalningsförsöket.
- Upprepade oförändrade statuskontroller ändrar inte notans version eller skapar extra ekonomiska journalhändelser. Tekniska `terminal.status`-poster bevaras i JSON men ersätter inga föreskrivna kassahändelser.

## Avgränsningar

Detta är **Cloud API-kopplingen**, inte en färdig AppSwitch/Capacitor-app. Softpays publika Cloud-specifikation beskriver en extern ECR, medan deras integrationssida också beskriver webbaserad växling på samma enhet. Detaljerna för den senare delen finns bakom utvecklarinloggning. AppSwitch-SDK, installation, certifieringsvillkor, automatisk förgrundsväxling och automatisk återgång till rätt Android-aktivitet behöver verifieras med leverantören.

Nuvarande startanrop skickar en notifiering till den valda Softpay-appen. Om Android inte visar appen automatiskt behöver användaren öppna den. Kassan kontrollerar samma betalning när användaren återvänder. Inga odokumenterade deeplänkar eller paketnamn används. Den förenklade Deep Linking-produkten, som inte lämnar tillbaka ett kontrollerbart resultat, används inte.

Dricks är avstängd i denna adapter. Den publika specifikationen beskriver terminalstyrd dricks men inte en verifierad motsvarighet till kassans i förväg låsta dricksbelopp. Surcharge och DCC begärs också avstängda; avvikande belopp godkänns inte lokalt. Beloppet måste vara 1–99 999 999 öre. Registrering av kostnadsfria artiklar får tills vidare provas i den lokala simulatorn.

Återbetalning utan närvarande kort kräver särskild behörighet hos Softpay och är inte implementerad. Funktionen `/cancel`, som kan återföra en genomförd transaktion, används inte för vanliga avbrott. Leverantörens betalningskvitto och avstämningsrapporter behöver också integreras inför kunddrift; ett simulerat kassakvitto ersätter dem inte.

`FAILED`, okända tillstånd, ofullständiga godkännanden och motsägande svar kräver utredning. Det finns ingen knapp som manuellt markerar en osäker betalning som godkänd. Ett lokalt säkerhetskopieåterställande kan sakna transaktioner som kommit till efter kopian; avstämning mot leverantören före fortsatt drift återstår. Denna koppling bevisar inte 99 % tillgänglighet under öppettiderna.

## Prova utan utvecklarkonto

```powershell
npm run build
npm run demo:softpay
```

Öppna `http://127.0.0.1:4793/`. Logga in med **Ansvarig / 1234 / LAGUSTOSA-TEST**. Öppna dagen, skapa en nota, skicka beställningen och välj **Ta betalt → Skicka till testterminal**. I vänteläget finns tydligt märkta lokala testknappar för godkännande, nekande och förlorat svar. Försök sedan ladda om sidan och återuppta betalningen.

Demot kör den riktiga nya adapterkoden mot en **lokal modell av API-svaren**. Det gör inga externa nätverksanrop och är inte Softpays sandbox. Testservern ligger under `tests/fixtures` och ingår inte i serverns distributionspaket. Den lyssnar enbart på loopback, har egen cookie, egen lagringsomfattning för betalningsförsök och en ny temporär databas vid varje start. Tidigare databaser bevaras. Stoppa med Ctrl+C. För annan ledig port: sätt `SOFTPAY_CONTRACT_PORT` före start.

## Anslut Softpays sandbox när kontot finns

1. Registrera utvecklarkonto och begär **Cloud API sandbox**, OAuth client credentials och testhandlare med SEK. AppSwitch-integratoruppgifter är inte automatiskt samma autentiseringsuppgifter som Cloud API.
2. Aktivera en stödd Android-enhet i Softpays sandbox. Skaffa leverantörens avsedda testkort; använd inte riktiga betalkort.
3. Kopiera `config/softpay-sandbox.example.json` till en privat installationsmapp. Ersätt samtliga exempelvärden med verkliga appId/storeId från testkontot och kassans faktiska deviceId. Ta bort rader för ännu ej kopplade enheter. Varje appId och deviceId får förekomma en gång.
4. Ange följande i serverns privata miljö. Skriv inte hemligheterna i Git, en frontendvariabel eller en delad logg:

```dotenv
APP_MODE=training
PAYMENT_ADAPTER=softpay-sandbox
FISCAL_ADAPTER=simulator
PRINT_ADAPTER=preview
DATA_DIR=<ny separat tom sandboxdatamapp>
BACKUP_DIR=<separat backupmapp för denna installation>
SESSION_COOKIE_NAME=eleva_softpay_sandbox
SOFTPAY_SANDBOX_CLIENT_ID=<Cloud API-klientens id>
SOFTPAY_SANDBOX_CLIENT_SECRET=<Cloud API-klientens hemlighet>
SOFTPAY_SANDBOX_MERCHANT_REFERENCE=<valfritt merchant-UUID>
SOFTPAY_SANDBOX_TERMINALS_FILE=<absolut sökväg till enhetsfilen>
```

Lämna `SOFTPAY_SANDBOX_MERCHANT_REFERENCE` tom om kontot redan entydigt väljer handlare. `TEST_ENVIRONMENT=safe-test` används inte här; den vanliga säkra övningsmiljön tillåter endast lokala simulatorer. Konfigurera HTTPS enligt README för telefoner i restaurangens nätverk. Starta därefter med `npm start`.

Databasen binds till sandboxkontot. Att byta handlare eller återstarta en sandboxdatabas med simulatorn avvisas. En konfigurationsändring byter inte terminal eller referens på ett redan startat försök. Uppgiften **Inställningar → Betalningar** visar konfigurerade kopplingar; den intygar inte att leverantörens app är online.

## Verifiering före nästa steg

```powershell
npm test
npm run build
npm run test:softpay:e2e
```

De nya testerna granskar bland annat fel belopp/valuta/enhet, ofullständiga godkännanden, tokenförnyelse, HTTP-fel, dubbla försök, fem samtidiga terminaler, avbrott, processomstart, delretur med artikelantal och mobil återhämtning efter omladdning. Webbläsarprovet använder den lokala modellen, inte ett leverantörskonto.

Före en riktig pilot behövs protokoll från ett **externt sandboxprov**: köp och retur med testkort, sena svar efter blipp, server-/app-/nätavbrott, terminalbyte, samtidiga enheter, återupptagning i Android och kontroll av leverantörens kvitto. Dricks, tillåtna återbetalningar, enhetsförvaltning och kommersiella distributionsvillkor måste beslutas. Kassaregistrets juridiska återstående arbete finns i README och påverkas inte av att ett korttest lyckas.

## Primärkällor

- [Softpay Cloud API, offentlig OpenAPI-specifikation](https://api.sandbox.softpay.io/api-gateway/v1/public/cloud-api-docs), hämtad 2026-10-14; info.version `0.1`, transaktions-API v3. SHA-256 för den granskade filen: `ed24c00d0441951ee704d4f6ee2e401e4bca99b0e4178edec6ecc389631a5c41`. Specifikationen distribueras inte i projektet.
- [AppSwitch, CloudSwitch och Deep Linking](https://softpay.io/solutions/integrated-softpos/).
- [Växla tillbaka till POS via Cloud API](https://support.softpay.io/en/articles/639398-how-to-switch-back-to-the-pos-app-using-cloud-api).
- [Androids appväxling och felsökning](https://support.softpay.io/en/articles/710717-how-can-i-troubleshoot-common-issues-with-softpay-integration-on-android-and-cloud-api).
- [Utvecklarkonto, sandbox och pilot](https://support.softpay.io/en/articles/531039-how-do-i-get-started-integrating-a-pos-system).
- [Sandbox och testkort](https://support.softpay.io/en/articles/822606-softpay-sandbox-environment-and-test-cards).
