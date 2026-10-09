import { expect, test } from "@playwright/test";

test("login renders without blank screen", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page.getByText("IDX.").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Entrar|Criar conta/ })).toBeVisible();
  await expect(page.locator("#root")).not.toBeEmpty();

  expect(errors).toEqual([]);
});

test("company access route renders the app shell", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/autoescola-vivo");
  await expect(page.getByText("IDX.").first()).toBeVisible();
  await expect(page.getByText("/autoescola-vivo")).toBeVisible();
  await expect(page.locator("#root")).not.toBeEmpty();

  expect(consoleErrors.filter((message) => !message.includes("favicon"))).toEqual([]);
});

test("authenticated smoke flow runs when credentials are provided", async ({ page }) => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  test.skip(!email || !password, "Set E2E_EMAIL and E2E_PASSWORD to exercise authenticated CRM navigation.");

  await page.goto("/");
  await page.getByLabel("Email").fill(email!);
  await page.getByLabel("Senha").fill(password!);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page.getByText(/Dashboard|Clientes|CRM/).first()).toBeVisible();
  await page.getByRole("button", { name: /CRM/ }).first().click();
  await expect(page.getByText("Pipeline CRM")).toBeVisible();
});
