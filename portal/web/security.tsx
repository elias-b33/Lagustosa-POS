import { useState } from "react";
import { Smartphone, ShieldCheck } from "lucide-react";
import {
  cancelEnrollment,
  enroll,
  verify,
  type Enrollment,
  type Session,
} from "./client";

export function AuthenticatorInstructions({ setup }: { setup: Enrollment }) {
  return (
    <div className="mfa-setup">
      <h3>Koppla Google Authenticator</h3>
      <ol>
        <li>
          Öppna <strong>Google Authenticator</strong> på mobilen.
        </li>
        <li>
          Tryck på <strong>+</strong>, välj <strong>Skanna en QR-kod</strong>{" "}
          och skanna här.
        </li>
        <li>
          Ange den sexsiffriga koden för <strong>Eleva Admin</strong> nedan.
        </li>
      </ol>
      <img
        src={setup.qr}
        width="180"
        height="180"
        alt="QR-kod för att koppla Eleva Admin till Google Authenticator"
      />
      <details>
        <summary>Kan du inte skanna? Ange en konfigurationsnyckel</summary>
        <p>
          Välj ”Ange en konfigurationsnyckel” i appen. Kontonamn: Eleva Admin.
          Nyckeltyp: Tidsbaserad.
        </p>
        <code>{setup.secret}</code>
      </details>
      <p>
        QR-koden och nyckeln ger tillgång till dina inloggningskoder. Dela dem
        inte.
      </p>
    </div>
  );
}

export function AuthenticatorHelp() {
  return (
    <details className="mfa-help">
      <summary>Ny mobil eller problem med koden?</summary>
      <p>
        Koden byts normalt var 30:e sekund. Använd nästa kod om den förra redan
        har använts, och kontrollera att mobilens datum och tid är automatiska.
      </p>
      <p>
        Flytta kontot med Google Authenticators överföring eller synkronisering
        innan du byter mobil. Om du förlorat åtkomsten behöver kontoansvarig
        verifiera din identitet innan verifieringen kan återställas. Ett
        återställt lösenord stänger inte av tvåstegsverifieringen.
      </p>
      <a
        href="https://support.google.com/accounts/answer/1066447?hl=sv"
        target="_blank"
        rel="noopener noreferrer"
      >
        Googles instruktioner för Authenticator
      </a>
    </details>
  );
}

export function AccountSecurity({
  identity,
  onUpdated,
}: {
  identity: Session;
  onUpdated: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false),
    [setup, setSetup] = useState<Enrollment | null>(null);
  const [password, setPassword] = useState(""),
    [code, setCode] = useState("");
  const [working, setWorking] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const disabled = identity.local && identity.mfaRequired === false;
  const act = async (work: () => Promise<void>) => {
    setWorking(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="account-security" aria-label="Google Authenticator">
      <div className="security-title">
        <Smartphone size={22} />
        <div>
          <h3>Google Authenticator</h3>
          <p>
            {disabled
              ? "Koppla mobilen när du vill testa tvåstegsverifieringen."
              : "Lösenord och en engångskod från din mobil skyddar inloggningen."}
          </p>
        </div>
      </div>
      {!editing && disabled && (
        <button
          className="button secondary"
          onClick={() => {
            setEditing(true);
            setMessage("");
          }}
        >
          Aktivera Google Authenticator
        </button>
      )}
      {!disabled && (
        <p className="security-active">
          <ShieldCheck size={17} /> Verifiering med mobilkod är aktiv.
        </p>
      )}
      {editing && (
        <form
          className="authenticator-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              if (!setup) {
                setSetup(await enroll(password));
                setPassword("");
              } else {
                await verify(code, setup.factorId);
                setSetup(null);
                setCode("");
                setEditing(false);
                await onUpdated();
                setMessage(
                  "Google Authenticator är aktiverad. Övriga inloggningar har avslutats. Nästa gång använder du lösenord och en ny kod från mobilen.",
                );
              }
            });
          }}
        >
          {!setup ? (
            <>
              <p>
                Bekräfta ditt lösenord. Skyddet aktiveras först efter att du har
                skannat QR-koden och bekräftat mobilkoden.
              </p>
              <label>
                Nuvarande lösenord
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={256}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              <AuthenticatorInstructions setup={setup} />
              <label>
                Sexsiffrig kod
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\D/g, ""))
                  }
                />
              </label>
            </>
          )}
          <div className="security-actions">
            <button className="button primary" disabled={working}>
              {working
                ? "Kontrollerar…"
                : setup
                  ? "Bekräfta och aktivera"
                  : "Visa QR-kod"}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={working}
              onClick={() =>
                void act(async () => {
                  await cancelEnrollment(setup?.factorId);
                  setSetup(null);
                  setPassword("");
                  setCode("");
                  setEditing(false);
                })
              }
            >
              Avbryt
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <AuthenticatorHelp />
    </section>
  );
}
