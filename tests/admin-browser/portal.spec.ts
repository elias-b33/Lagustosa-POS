import { test, expect, type Page } from "@playwright/test";

import { readFileSync } from "node:fs";

import path from "node:path";

import { totp } from "../../portal/local/auth";

const directory = process.env.ADMIN_TEST_DIR!;

async function login(page: Page) {
  const config = JSON.parse(
    readFileSync(path.join(directory, "local-account.json"), "utf8"),
  );

  const password = readFileSync(path.join(directory, "inloggning.txt"), "utf8")
    .match(/Lösenord: (.+)/)![1]
    .trim();

  await page.goto("/");

  await page.getByLabel("E-post", { exact: true }).fill(config.email);

  await page.getByLabel("Lösenord", { exact: true }).fill(password);

  await page.getByRole("button", { name: "Logga in", exact: true }).click();

  if (process.env.ADMIN_TEST_PASSWORD_ONLY === "1") {
    await expect(page.getByLabel("Sexsiffrig kod")).toHaveCount(0);

    await expect

      .poll(async () => (await page.request.get("/api/auth/session")).json())

      .toMatchObject({ verified: true, mfaRequired: false });
  } else {
    await expect(page.getByLabel("Sexsiffrig kod")).toBeVisible();

    expect((await page.request.get("/api/meta")).status()).toBe(401);

    if (!config.enrolled) {
      await page
        .getByRole("button", {
          name: "Koppla Google Authenticator",
          exact: true,
        })
        .click();
      await expect(
        page.getByAltText(
          "QR-kod för att koppla Eleva Admin till Google Authenticator",
        ),
      ).toBeVisible();
    }
    // Respect the single-use time step even when several tests log in during one 30-second period.
    const latest = JSON.parse(
      readFileSync(path.join(directory, "local-account.json"), "utf8"),
    );
    await expect
      .poll(
        () => Math.floor(Date.now() / 30000) + 1 > (latest.lastTotpStep ?? -1),
        { timeout: 35000 },
      )
      .toBe(true);
    const step = Math.max(
      Math.floor(Date.now() / 30000),
      (latest.lastTotpStep ?? -1) + 1,
    );
    await page
      .getByLabel("Sexsiffrig kod")
      .fill(totp(config.secret, step * 30000));

    await page

      .getByRole("button", { name: "Öppna Admin", exact: true })

      .click();
  }

  await expect(
    page.getByRole("heading", { name: "Översikt", exact: true }),
  ).toBeVisible();

  await expect(
    page.getByText("Försäljning efter returer", { exact: true }).first(),
  ).toBeVisible();
}

test("kräver inloggning enligt testets policy, stödjer filter, export och utloggning", async ({
  page,
}) => {
  expect((await page.request.get("/api/meta")).status()).toBe(401);

  expect(
    (
      await page.request.post("/api/auth/login", {
        data: { email: "ansvarig@eleva.test", password: "incorrect-password" },
      })
    ).status(),
  ).toBe(401);

  await login(page);

  await page.getByRole("button", { name: "Denna vecka", exact: true }).click();

  await expect(page.locator(".metric").first()).toContainText("kr");

  await page.getByRole("button", { name: "Visa tabell", exact: true }).click();

  await expect(page.locator(".chart-table")).toBeVisible();

  await page.getByLabel("Momsvisning").selectOption("ex");

  await expect(page.locator(".panel-heading").first()).toContainText(
    "exkl. moms",
  );

  const download = page.waitForEvent("download");

  await page.getByRole("button", { name: "Exportera", exact: true }).click();

  expect((await download).suggestedFilename()).toContain("eleva-statistik");

  await page
    .getByRole("button", { name: "Artikelförsäljning", exact: true })
    .click();

  await page.getByLabel("Sök artikel").fill("margherita");

  await expect(page.locator("tbody")).toContainText("Margherita");

  await expect(page.locator("tbody")).not.toContainText("Bröd");

  const productDownload = page.waitForEvent("download");

  await page.getByRole("button", { name: "Exportera", exact: true }).click();

  const file = await (await productDownload).path();

  const csv = readFileSync(file!, "utf8");

  expect(csv).toContain("Margherita");

  expect(csv).not.toContain("Bröd");

  await page.getByRole("button", { name: "Logga ut", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "Välkommen tillbaka" }),
  ).toBeVisible();

  expect((await page.request.get("/api/meta")).status()).toBe(401);
});

test("beställningar är skrivskyddade och visar betalningssammanfattning", async ({
  page,
}) => {
  await login(page);

  await page.getByRole("button", { name: /^Beställningar/ }).click();

  await expect(page.locator(".order-card")).toHaveCount(2);

  const opener = page

    .getByRole("button", { name: "Visa sammanfattning" })

    .first();

  await opener.click();

  await expect(page.getByRole("dialog")).toContainText("Kvar att betala");

  await page.keyboard.press("Shift+Tab");

  await expect(
    page

      .getByRole("dialog")

      .getByRole("button", { name: "Stäng", exact: true }),
  ).toBeFocused();

  await page.keyboard.press("Tab");

  await expect(
    page.getByRole("button", { name: "Stäng sammanfattning" }),
  ).toBeFocused();

  await page.keyboard.press("Escape");

  await expect(page.getByRole("dialog")).toHaveCount(0);

  await expect(opener).toBeFocused();

  await page.getByRole("button", { name: "Driftstatus", exact: true }).click();

  await expect(page.getByText("Ingen aktiv anslutning").first()).toBeVisible();

  expect(
    (
      await page.request.post("/api/anything", { data: { action: "pay" } })
    ).status(),
  ).toBeGreaterThanOrEqual(400);
});

test("visar fördröjning, låter konto fungera före synkning och rensar återkallad åtkomst", async ({
  page,
}) => {
  await login(page);

  await page.route("**/api/meta", async (route) => {
    const response = await route.fetch();

    const body = await response.json();

    await route.fulfill({
      json: {
        ...body,

        generatedAt: new Date(Date.now() - 180000).toISOString(),
      },
    });
  });

  await page.getByRole("button", { name: "Uppdatera statistik" }).click();

  await expect(
    page.getByText(/Uppgifterna är äldre än två minuter/),
  ).toBeVisible();

  await page.unroute("**/api/meta");

  await page.route("**/api/meta", (route) =>
    route.fulfill({
      status: 503,

      json: { message: "Väntar på första synkningen." },
    }),
  );

  await page.goto("/account");

  await expect(
    page.getByRole("heading", { name: "Din inloggning" }),
  ).toBeVisible();

  if (process.env.ADMIN_TEST_PASSWORD_ONLY === "1")
    await expect(page.getByText("Avstängd i lokalt test")).toBeVisible();

  await page.unroute("**/api/meta");

  await page.route("**/api/meta", (route) =>
    route.fulfill({ status: 403, json: { message: "Åtkomst återkallad." } }),
  );

  await page.getByRole("button", { name: "Uppdatera statistik" }).click();

  await expect(
    page.getByRole("heading", { name: "Välkommen tillbaka" }),
  ).toBeVisible();

  await expect(page.locator(".metric")).toHaveCount(0);
});

test("responsiv översikt, mobilmeny och skärmbilder utan horisontellt sidspill", async ({
  page,
}) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await login(page);

  await page.getByRole("button", { name: "Denna vecka", exact: true }).click();

  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });

    await expect(page.locator(".metrics")).toBeVisible();

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);

    await page.screenshot({
      path: `artifacts/admin-${width}.png`,

      fullPage: true,

      animations: "disabled",
    });

    if (width <= 1024) {
      await page

        .getByRole("button", { name: "Öppna meny", exact: true })

        .click();

      await expect(
        page.getByRole("navigation", { name: "Huvudmeny" }),
      ).toBeInViewport();

      await page.getByRole("button", { name: "Översikt", exact: true }).click();
    }
  }

  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole("button", { name: "Försäljning", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "Försäljningar och returer" }),
  ).toBeVisible();

  await page.screenshot({ path: "artifacts/admin-sales.png", fullPage: true });

  expect(errors).toEqual([]);
});

test("butik, kupong och lager sparas genom kassans kontroller och historik kan öppnas", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Produkter", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Produktkatalog" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Ny produkt", exact: true }).click();
  await page.getByLabel("Namn", { exact: true }).fill("Admin testartikel");
  await page.getByLabel("Pris inkl. moms (kr)", { exact: true }).fill("129,50");
  await page
    .getByRole("button", { name: "Spara till kassan", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText("Genomförd", { exact: true }).first(),
  ).toBeVisible({ timeout: 40000 });
  await page.getByLabel("Sök i listan").fill("Admin testartikel");
  await expect(page.locator(".mg-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".mg-table tbody")).toContainText("129,50");
  await page.getByRole("button", { name: "Kuponger", exact: true }).click();
  await page.getByRole("button", { name: "Ny kupong", exact: true }).click();
  await page.getByLabel("Namn", { exact: true }).fill("Välkommen hem");
  await page.getByLabel("Kupongkod", { exact: true }).fill("HEMTEST");
  await page.getByLabel("Rabatt (%)", { exact: true }).fill("12.5");
  await page
    .getByRole("button", { name: "Spara till kassan", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".mg-table tbody")).toContainText("HEMTEST", {
    timeout: 40000,
  });
  await page.getByRole("button", { name: "Lager", exact: true }).click();
  await page.getByLabel("Sök i listan").fill("Admin testartikel");
  await page.getByRole("button", { name: "Ändra Admin testartikel" }).click();
  await page.getByLabel("Antal", { exact: true }).fill("35");
  await page.getByLabel("Lagerför artikeln", { exact: true }).check();
  await page
    .getByLabel("Orsak / underlag", { exact: true })
    .fill("Browserprov inventering");
  await page
    .getByRole("button", { name: "Spara till kassan", exact: true })
    .click();
  await expect(page.locator(".mg-table").first()).toContainText("35 st", {
    timeout: 40000,
  });
  await page
    .getByRole("button", { name: "Inställningar", exact: true })
    .click();
  await page.getByRole("tab", { name: "Enheter", exact: true }).click();
  await expect(page.locator(".mg-table tbody")).toContainText("Huvudkassa");
  await page.getByRole("button", { name: "Rapporter", exact: true }).click();
  await page.getByLabel("Från", { exact: true }).fill("2026-10-15");
  await page.getByLabel("Till", { exact: true }).fill("2026-10-17");
  await page
    .getByRole("button", { name: "Visa detaljer", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toContainText("Träningsrapport");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Spara underlaget", exact: true })
    .click();
  expect((await download).suggestedFilename()).toContain("-test.json");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Orderhistorik", exact: true })
    .click();
  await page.getByLabel("Från", { exact: true }).fill("2026-10-15");
  await page.getByLabel("Till", { exact: true }).fill("2026-10-17");
  await page.getByLabel("Historikstatus").selectOption("paid");
  await page
    .getByRole("button", { name: "Visa detaljer", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Godkända försäljningsbetalningar",
  );
  await expect(page.getByRole("dialog")).toContainText("Margherita");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Produkter", exact: true }).click();
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    if (await page.locator(".sidebar.nav-open").count())
      await page
        .getByRole("button", { name: "Stäng meny", exact: true })
        .click();
    await expect(
      page.getByRole("heading", { name: "Produktkatalog" }),
    ).toBeVisible();
    await page.screenshot({
      path: `artifacts/admin-management-${width}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
});

test("nekar främmande ursprung och värdnamn samt begränsar inloggningsunderlag", async ({
  request,
}) => {
  expect(
    (
      await request.get("/api/auth/session", {
        headers: { host: "attacker.example" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/auth/login", {
        headers: { origin: "https://attacker.example" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/auth/login", {
        headers: { "sec-fetch-site": "cross-site" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/auth/login", {
        headers: { "content-type": "text/plain" },
        data: "{}",
      })
    ).status(),
  ).toBe(415);
  const large = await request.post("/api/auth/login", {
    data: { email: "x".repeat(5000), password: "x" },
  });
  expect(large.status()).toBe(413);
  expect(await large.text()).not.toContain("stack");
  const response = await request.get("/");
  expect(response.headers()["content-security-policy"]).toContain(
    "base-uri 'self'",
  );
});

test("kopplar Google Authenticator från Mitt konto och bevarar skyddet vid nästa inloggning", async ({
  page,
}) => {
  test.skip(
    process.env.ADMIN_TEST_PASSWORD_ONLY !== "1",
    "Aktivering från lösenordsläge testas i den lokala testpolicyn.",
  );
  await login(page);
  await page.getByRole("button", { name: "Mitt konto", exact: true }).click();
  await page
    .getByRole("button", { name: "Aktivera Google Authenticator", exact: true })
    .click();
  const password = readFileSync(path.join(directory, "inloggning.txt"), "utf8")
    .match(/Lösenord: (.+)/)![1]
    .trim();
  await page.getByLabel("Nuvarande lösenord", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Visa QR-kod", exact: true }).click();
  await expect(
    page.getByAltText(
      "QR-kod för att koppla Eleva Admin till Google Authenticator",
    ),
  ).toBeVisible();
  const secret = (await page.locator(".mfa-setup code").textContent())!;
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({
      path: `artifacts/admin-authenticator-${width}.png`,
      fullPage: true,
      mask: [page.locator(".mfa-setup img"), page.locator(".mfa-setup code")],
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await expect(
    (await page.request.get("/api/auth/session")).json(),
  ).resolves.toMatchObject({ mfaRequired: false });
  await page.getByLabel("Sexsiffrig kod", { exact: true }).fill(totp(secret));
  await page
    .getByRole("button", { name: "Bekräfta och aktivera", exact: true })
    .click();
  await expect(
    page.getByText("Verifiering med mobilkod är aktiv.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".mfa-setup")).toHaveCount(0);
  const config = JSON.parse(
    readFileSync(path.join(directory, "local-account.json"), "utf8"),
  );
  expect(config.requireMfa).toBe(true);
  expect(config.enrolled).toBe(true);
  const old = await page.context().cookies();
  await page
    .getByRole("button", { name: "Logga ut", exact: true })
    .last()
    .click();
  await page.getByLabel("E-post", { exact: true }).fill(config.email);
  await page.getByLabel("Lösenord", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(page.getByLabel("Sexsiffrig kod")).toBeVisible();
  expect((await page.request.get("/api/meta")).status()).toBe(401);
  expect(
    (
      await page.request.get("/api/meta", {
        headers: { cookie: old.map((c) => `${c.name}=${c.value}`).join("; ") },
      })
    ).status(),
  ).toBe(401);
  expect(
    (await page.request.post("/api/auth/enroll", { data: {} })).status(),
  ).toBe(403);
});
