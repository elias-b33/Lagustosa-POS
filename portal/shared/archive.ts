import type { PortalDay, AnalyticsQuery } from "./model.ts";
export function archivePage(
  days: PortalDay[],
  query: AnalyticsQuery & {
    view: string;
    search?: string;
    status?: string;
    page?: number;
  },
) {
  const field =
    query.view === "history"
      ? "orders"
      : query.view === "reports"
        ? "reports"
        : "events";
  const period = days.filter(
    (day) => day.date >= query.from && day.date <= query.to,
  );
  const rows = period.flatMap((day) =>
    (day[field] ?? []).map((row) => ({ ...row, date: day.date })),
  );
  const search = (query.search ?? "").toLocaleLowerCase("sv-SE");
  const filtered = rows
    .filter((row) => {
      if (
        query.registerId &&
        (!("registerId" in row) || row.registerId !== query.registerId)
      )
        return false;
      if (
        query.status &&
        ("status" in row ? row.status : "kind" in row ? row.kind : "") !==
          query.status
      )
        return false;
      return (
        !search ||
        JSON.stringify(row).toLocaleLowerCase("sv-SE").includes(search)
      );
    })
    .sort((a, b) =>
      ("at" in b ? b.at : b.openedAt).localeCompare(
        "at" in a ? a.at : a.openedAt,
      ),
    );
  const page = Math.min(
    Math.max(1, Math.floor(query.page ?? 1)),
    Math.max(1, Math.ceil(filtered.length / 25)),
  );
  return {
    rows: filtered.slice((page - 1) * 25, page * 25),
    total: filtered.length,
    page,
    pages: Math.max(1, Math.ceil(filtered.length / 25)),
    complete: period.every((day) => day[field] !== undefined),
  };
}
