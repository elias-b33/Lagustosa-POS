# Tredjepartslicenser och distributionsunderlag

Denna fil beskriver licensunderlaget för den granskade träningsversionen. Den är inte en kommersiell licens till själva kassaprogrammet, ett bevis på äganderätt till källkoden, tillstånd till restaurangens varumärke eller ett intyg om att produkten uppfyller kassareglerna.

## Vad följer med ett bygge?

`npm run build` kör `scripts/generate-third-party-notices.mjs` före Vite. Den jämför driftberoendena i `package-lock.json` med installerade paketnamn, versioner, licensmetadata och de fullständiga licens- och copyrighttexternas kontrollsummor. Ett nytt paket, ändrad version, oväntad licensfil, saknad text eller ändrad font stoppar bygget tills underlaget har granskats.

Webbbygget innehåller:

- `/licenses/generated/THIRD-PARTY-NOTICES.txt`: fullständiga bevarade texter för alla granskade npm-driftberoenden, IBM Plex Sans och kompletterande notiser från byggverktyg som kan bidra med hjälpkod.
- `/licenses/generated/THIRD-PARTY-MANIFEST.json`: versioner, licensmetadata, textkontrollsummor och granskningsomfattning.
- `/licenses/ibm-plex-sans-OFL.txt`: fontens separata fullständiga OFL-text.

Notiserna innehåller konservativt även serverkomponenter som inte finns i webbläsarens JavaScript och byggverktygens medföljande tredjepartstexter. Det betyder inte att samtliga dessa komponenter distribueras som körbar kod till webbläsaren. Vanliga byggverktygslicenser och eventuella källkodskrav måste bedömas på nytt om själva utvecklingsmiljön börjar distribueras.

Windows-paketeringen verifierar driftpaketen på nytt **efter** `npm ci --omit=dev`. Den skriver `THIRD-PARTY-NOTICES.txt` och `THIRD-PARTY-MANIFEST.json` i paketets rot, och kopierar den fullständiga, versionsbundna Node.js-licensen inklusive Node.js tredjepartsnotiser till `runtime/LICENSE`. `BUILD-INFO.json` anger licensmanifestets SHA-256. Ingen färdig ZIP skapas om kontrollen misslyckas.

En Node-version som saknar granskat underlag stoppas. Den första granskningen omfattar Node v24.16.0 och bevarar exakt text från [Node.js motsvarande version](https://raw.githubusercontent.com/nodejs/node/v24.16.0/LICENSE). CI använder den exakta versionen i `.node-version` för att inte oavsiktligt byta distribuerad runtime utan licensgranskning. Versionspinnen ska uppdateras tillsammans med säkerhets- och licensgranskningen vid en Node-uppdatering. Kontroll av versionssträngen och registrering av binärens hash är inte en oberoende verifiering av en egenkompilerad eller modifierad Node-binärs innehåll.

## Granskat underlag

`vendor/licenses/reviewed-components.json` binder posterna till version och licenstext. Kontrollsummor för text beräknas efter normalisering av CRLF/CR till LF, så att en Git-utcheckning på Windows inte ändrar resultatet. Font- och binärkontrollsummor beräknas på oförändrade bytes. Originaltexterna under `vendor/licenses/upstream/` ändras inte av generatorn. Generering gör inga nätverksanrop.

Den 13 oktober 2026 hade låsfilen 284 paketposter: 99 driftposter och 185 utvecklingsposter. Samtliga hade licensmetadata. Driftposternas deklarerade licenser var MIT (79), ISC (6), BSD-3-Clause (5), BSD-2-Clause (1), BlueOak-1.0.0 (5), Apache-2.0 (1) och 0BSD (2). Inga GPL-/AGPL-poster framkom i denna metadata. Detta är en inventering, inte en slutsats om varje inbäddad kodfil eller framtida version.

Några poster kräver särskild uppmärksamhet:

- **Lucide React 0.577.0:** metadata anger ISC, men den medföljande `LICENSE` innehåller också MIT-villkor för delar från Feather. Hela texten bevaras; metadata ersätter inte dessa villkor.
- **reflect-metadata och tslib:** även separata `CopyrightNotice.txt` bevaras, utöver respektive huvudlicens. Generatorn samlar filer vars namn innehåller license/licence, notice, copyright eller copying.
- **abstract-logging 2.0.1:** paketet saknar separat licensfil. Dess publicerade `Readme.md` länkar till `http://jsumners.mit-license.org/`. Den fullständiga texten från [den länkade utgivarens textendpoint](https://jsumners.mit-license.org/license.txt) har bevarats med hämtningstid och hash. Webbplatsen använder aktuellt år i copyrighttexten; detta påstås inte vara paketets ursprungliga utgivningsår. Ingen copyrightinnehavare eller egen licenstext har gissats.
- **IBM Plex Sans:** fontfilens hash och fullständiga [OFL 1.1-text från IBM](https://github.com/IBM/plex/blob/master/LICENSE.txt) är dokumenterade. Fonten får distribueras med kommersiell programvara enligt licensen, men villkoren för copyright, licenstext, separat försäljning och det reserverade namnet Plex måste respekteras. Hashen fastställer den lokala filen; exakt fontversions-/anskaffningshistorik behöver fortfarande dokumenteras.
- **Lightning CSS:** de 12 MPL-2.0-posterna i låsfilen är utvecklings-/byggberoenden och installeras inte av Windows-paketets driftinstallation. Att ett byggverktyg används för CSS innebär inte i sig att programmets oberoende källkod får samma licens. Om MPL-komponenten, dess modifierade filer eller utvecklingsverktygen distribueras måste deras faktiska distributions- och källkodsvillkor följas.

## Kvarvarande rättighets- och granskningsarbete

- Restauranglogotypen i `web/assets/lagustosa-wordmark.svg` kommer enligt projektets README från Lagustosas webbplats. Någon skriftlig rätt till generell vidareförsäljning, kundanpassning eller marknadsföring under denna logotyp har inte verifierats. Bevara dokumenterat tillstånd från rätt innehavare eller välj separat produktprofil innan bred distribution. Filen har inte tagits bort av denna granskning.
- Bekräfta rättighetskedjan för programkod från ursprungsarkivet, mänskliga bidrag, konsulter och egna illustrationer. Ett Git-commit, en kommentar om att material är eget eller `private: true` i package.json ersätter inte rättighetsunderlag.
- Kundspecifik meny, varumärke och marknadsföringsmaterial behöver avtalat användningsområde. Mallar och demon för andra restauranger bör använda material som leverantören får distribuera där.
- De officiella XSD-filerna under `vendor/skatteverket` har källhänvisningar, men uttryckliga villkor för vidarepaketering har inte fastställts i denna granskning. Bekräfta villkoren och bevara proveniens; deras närvaro är inte bevis på myndighetsgodkännande.
- Licensfiler på paketrot, granskade kompletteringar och byggverktygstexter är inte en fullständig automatisk skanning av alla källfiler, kod som bäddats in i beroenden, native-binärer eller nya tillägg. För en slutlig kommersiell release behövs kontroll mot de faktiskt distribuerade filerna och eventuell ytterligare upphovsrätts-/patent-/varumärkesbedömning.

## Vid en uppdatering

Installera den nya låsta versionen. Läs dess fullständiga licenser, medföljande notices/copyrightfiler och relevanta inbäddade komponenter. Bedöm distributionsvillkoren och dokumentera källa för eventuella kompletteringar. Uppdatera därefter den versionsbundna granskningsposten och dess kontrollsummor. Lägg till fullständig licens från motsvarande officiella Node-version innan ett annat Node-runtime paketeras. Uppdatera aldrig granskningshashar enbart för att få en felande kontroll att passera.

Kör `npm run build` och `npm run package:windows`, och kontrollera de faktiska resultaten. Kommersiella villkor för programmet ska hänvisa till tredjepartskomponenternas egna rättigheter och får inte utge sig för att ersätta dem.
