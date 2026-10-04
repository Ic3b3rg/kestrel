import { expect, type Locator, type Page } from "@playwright/test";

// dnd-kit activates after movement; move again after activation to enter the target.
export async function dragIssueToInProgress(page: Page, card: Locator, target: Locator) {
  const handle = card.getByRole("button", { name: "Drag to In progress", exact: true });
  await handle.scrollIntoViewIfNeeded();
  const source = await handle.boundingBox();
  const destination = await target.boundingBox();
  if (source === null || destination === null) throw new Error("Board card or column missing");
  const x = source.x + source.width / 2;
  const y = source.y + source.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    await page.mouse.move(x + 16, y, { steps: 2 });
    await expect(page.getByText("Move to In progress", { exact: true })).toBeVisible();
    await page.mouse.move(
      destination.x + destination.width / 2,
      Math.max(destination.y + 8, Math.min(y, destination.y + destination.height - 8)),
      { steps: 12 },
    );
  } finally {
    await page.mouse.up();
  }
}
