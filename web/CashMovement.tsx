import { useState } from 'react';
import { money, parseMoney } from '../shared/money';
import type { CashMovementInput } from '../shared/cash-inputs';
import { Action, Field, Modal, type WorkspaceProps } from './components';
import { newKey } from './api';
import { readCashAttempt, submitCashMovement } from './cash-movement-attempt';

export function CashMovementModal({ data, busy, run, onClose }: WorkspaceProps & { onClose: () => void }) {
  const [initial] = useState(() => {
    try { return { pending: readCashAttempt(data.actor, localStorage, data.testRoundId), error: '' }; }
    catch (error) { return { pending: null, error: (error as Error).message }; }
  });
  const [pending, setPending] = useState<CashMovementInput | null>(initial.pending);
  const [error, setError] = useState(initial.error);
  const [direction, setDirection] = useState<'in' | 'out'>(initial.pending?.direction ?? 'in');
  const [amount, setAmount] = useState(initial.pending ? String(initial.pending.amountOre / 100) : '');
  const [reason, setReason] = useState(initial.pending?.reason ?? '');
  const amountOre = parseMoney(amount);
  const expected = data.report?.expectedCashOre ?? 0;
  const invalid = amountOre === null || amountOre <= 0 || amountOre > 100000000 || reason.trim().length < 3 || reason.trim().length > 500 || direction === 'out' && amountOre > expected || !data.currentDay;
  const submit = async () => {
    if (!pending && invalid) return;
    const input = pending ?? { key: newKey(), dayId: data.currentDay!.id, direction, amountOre: amountOre!, reason: reason.trim() };
    await run(async () => {
      setPending(input);
      try {
        const result = await submitCashMovement(input, data.actor, localStorage, data.testRoundId);
        onClose();
        return result;
      } finally {
        try { setPending(readCashAttempt(data.actor, localStorage, data.testRoundId)); }
        catch (issue) { setError((issue as Error).message); }
      }
    }, 'Kontanthändelsen är registrerad i övningsjournalen.');
  };
  return <Modal title="Registrera kontanthändelse" subtitle="Träning · insättningar och uttag sparas med belopp, orsak och ansvarig kassör." onClose={onClose}>
    <p>Förväntad kontantkassa: <strong>{money(expected)}</strong></p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {pending && <div className="notice warning">En kontanthändelse väntar på bekräftelse. Kontrollera samma registrering för att undvika dubbla belopp.</div>}
    <fieldset className="payment-fields" disabled={busy || !!pending || !!error}>
      <Field label="Händelse"><select value={direction} onChange={event => setDirection(event.target.value as 'in' | 'out')}><option value="in">Insättning</option><option value="out">Uttag</option></select></Field>
      <Field label="Belopp i kronor"><input value={amount} inputMode="decimal" onChange={event => setAmount(event.target.value)} /></Field>
      <Field label="Orsak"><textarea value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></Field>
    </fieldset>
    {direction === 'out' && amountOre !== null && amountOre > expected && !pending && <p className="form-error">Uttaget överstiger den förväntade kontantkassan.</p>}
    <Action disabled={busy || !!error || !pending && invalid} onClick={() => void submit()}>{pending ? 'Kontrollera samma kontanthändelse' : 'Registrera kontanthändelse'}</Action>
  </Modal>;
}
