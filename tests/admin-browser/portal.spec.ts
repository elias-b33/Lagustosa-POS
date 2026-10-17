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
    await page.getByLabel("Sexsiffrig kod").fill(totp(config.secret));
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
  await page.getByRole("button", { name: "Artiklar", exact: true }).click();
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
  await expect(
    page.getByText("Anslutningsstatus har inte överförts"),
  ).toBeVisible();
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
