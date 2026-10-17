import type { MenuItem } from "../shared/types";
import type { Store } from "./db";
import type { Category } from "../shared/backoffice";
/** Preserve the existing menu order until a category order is explicitly configured. */
export function orderBackofficeMenu(
  menu: MenuItem[],
  store: Store,
): MenuItem[] {
  const configured = store.all<Category>("backoffice-category");
  if (!configured.length) return menu;
  const names = [...new Set(menu.map((p) => p.category))];
  const positions = new Map(
    names.map((name, index) => [
      name,
      configured.find((c) => c.name === name)?.position ?? index,
    ]),
  );
  return menu
    .map((value, index) => ({ value, index }))
    .sort(
      (a, b) =>
        (positions.get(a.value.category) ?? 0) -
          (positions.get(b.value.category) ?? 0) ||
        names.indexOf(a.value.category) - names.indexOf(b.value.category) ||
        a.index - b.index,
    )
    .map((row) => row.value);
}
