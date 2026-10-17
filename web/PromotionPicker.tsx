import { useEffect, useState } from "react";
import { TicketPercent } from "lucide-react";
import { api } from "./api";
import { Action, Field, Modal } from "./components";
import type { Tab } from "../shared/types";
export function PromotionPicker({
  tab,
  disabled,
  onApply,
}: {
  tab: Tab;
  disabled: boolean;
  onApply: (input: Record<string, unknown>) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false),
    [campaigns, setCampaigns] = useState<
      { id: string; name: string; discountBps: number }[]
    >([]),
    [code, setCode] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    if (open)
      void api<typeof campaigns>("/promotions")
        .then(setCampaigns)
        .catch((e) => setError(e.message));
  }, [open]);
  const apply = async (input: Record<string, unknown>) => {
    setError("");
    try {
      if (await onApply({ action: "promotion", ...input })) {
        setOpen(false);
        setCode("");
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <button disabled={disabled} onClick={() => setOpen(true)}>
        <TicketPercent size={14} /> {tab.promotion?.name ?? "Erbjudande"}
      </button>
      {open && (
        <Modal
          title="Kupong eller kampanj"
          subtitle={tab.label}
          onClose={() => setOpen(false)}
        >
          {tab.promotion && (
            <p>
              Valt: {tab.promotion.name} · {tab.discountBps / 100} %. Ändra
              eller ta bort via Rabatt.
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void apply({ couponCode: code });
            }}
          >
            <Field label="Kupongkod">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                minLength={3}
                maxLength={32}
                required
                autoComplete="off"
              />
            </Field>
            <Action type="submit" disabled={disabled || code.trim().length < 3}>
              Använd kupong
            </Action>
          </form>
          <h3>Aktuella kampanjer</h3>
          {campaigns.length ? (
            campaigns.map((c) => (
              <Action
                key={c.id}
                secondary
                disabled={disabled}
                onClick={() => void apply({ promotionId: c.id })}
              >
                {c.name} · {c.discountBps / 100} %
              </Action>
            ))
          ) : (
            <p>Inga kampanjer gäller just nu.</p>
          )}
          {error && <p role="alert">{error}</p>}
          <p>
            En rabatt per nota. Befintliga erbjudanden ersätts; rabatter staplas
            inte.
          </p>
        </Modal>
      )}
    </>
  );
}
