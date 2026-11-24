import { useEffect, useState } from "react";
import { Fingerprint, KeyRound, ShieldCheck, UserRound } from "lucide-react";
import { helloAvailable, helloVerify } from "@/lib/platform";
import { Button, Card, Input, Select, cx } from "@/components/ui";
import { accounts, useAccounts } from "../useAccounts";

/**
 * The door to the Accounts area. The manager signs in with Windows Hello
 * (fingerprint, face or the Windows PIN) or with the manager passcode; a
 * tasker signs in with their name and PIN and only sees their own side.
 */
export function SignIn() {
  const { people, hasPasscode } = useAccounts((s) => ({ people: s.books.people, hasPasscode: !!s.adminSecret }));
  const [who, setWho] = useState<"manager" | "tasker">("manager");
  const [hello, setHello] = useState(false);
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [person, setPerson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const taskers = people.filter((p) => p.tasker && p.active && p.pin);

  useEffect(() => {
    void helloAvailable().then(setHello);
  }, []);

  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    try {
      setError(await work());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPin("");
      setAgain("");
    }
  };

  const withHello = () =>
    run(async () => {
      if (!(await helloVerify("Sign in to NEXUS Accounts"))) return "Windows did not verify you. Try again, or use the passcode.";
      accounts().signInVerified();
      return null;
    });
  const withPasscode = () => run(async () => ((await accounts().signInAdmin(pin)) ? null : "That passcode is not right."));
  const create = () => run(async () => (pin !== again ? "The two passcodes are not the same." : accounts().setAdminPasscode(pin)));
  const asTasker = () => run(async () => (!person ? "Choose your name." : (await accounts().signInTasker(person, pin)) ? null : "That PIN is not right."));

  return (
    <div className="flex justify-center pt-6">
      <Card className="w-full max-w-md p-6 flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <span className="h-11 w-11 rounded-xl flex items-center justify-center text-accent bg-[color-mix(in_oklab,var(--accent)_14%,transparent)]"><ShieldCheck size={22} /></span>
          <div>
            <h1 className="font-display text-xl font-semibold">Accounts</h1>
            <p className="text-xs text-muted">Managed accounts, taskers, tasks and the money behind them. Sign in to continue.</p>
          </div>
        </div>

        {hasPasscode && (
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Who is signing in">
            {([["manager", "Manager", <KeyRound key="k" size={15} />], ["tasker", "Tasker", <UserRound key="u" size={15} />]] as const).map(([id, label, icon]) => (
              <button key={id} type="button" role="radio" aria-checked={who === id} onClick={() => { setWho(id); setError(null); }} className={cx("h-10 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 transition", who === id ? "border-accent text-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]" : "border-line text-fg-2 hover:text-fg")}>
                {icon}{label}
              </button>
            ))}
          </div>
        )}

        {!hasPasscode ? (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <p className="text-sm text-fg-2">First, choose a manager passcode. It protects this area and is the way in when Windows Hello is not available.</p>
            <Input type="password" autoFocus placeholder="New passcode (4 characters or more)" value={pin} onChange={(e) => setPin(e.target.value)} aria-label="New passcode" />
            <Input type="password" placeholder="Repeat it" value={again} onChange={(e) => setAgain(e.target.value)} aria-label="Repeat the passcode" />
            <Button type="submit" variant="primary" disabled={busy || !pin}>Create and sign in</Button>
          </form>
        ) : who === "manager" ? (
          <div className="flex flex-col gap-3">
            {hello && (
              <>
                <Button variant="primary" size="lg" icon={<Fingerprint size={18} />} disabled={busy} onClick={() => void withHello()}>Sign in with Windows Hello</Button>
                <p className="text-[11px] text-muted text-center -mt-1">Fingerprint, face or your Windows PIN. Windows does the checking; NEXUS never sees your fingerprint.</p>
                <div className="flex items-center gap-3 text-[11px] text-muted"><span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" /></div>
              </>
            )}
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void withPasscode(); }}>
              <Input type="password" autoFocus={!hello} placeholder="Manager passcode" value={pin} onChange={(e) => setPin(e.target.value)} aria-label="Manager passcode" />
              <Button type="submit" variant={hello ? "soft" : "primary"} disabled={busy || !pin}>Sign in</Button>
            </form>
            {!hello && <p className="text-[11px] text-muted">Windows Hello is not set up on this PC (or this is a preview), so the passcode is used.</p>}
          </div>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void asTasker(); }}>
            {taskers.length === 0 ? (
              <p className="text-sm text-muted">No tasker has a PIN yet. The manager gives each tasker one under People.</p>
            ) : (
              <>
                <Select value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Your name">
                  <option value="">Choose your name…</option>
                  {taskers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <Input type="password" placeholder="Your PIN" value={pin} onChange={(e) => setPin(e.target.value)} aria-label="Your PIN" />
                <Button type="submit" variant="primary" disabled={busy || !pin || !person}>Sign in</Button>
              </>
            )}
          </form>
        )}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      </Card>
    </div>
  );
}
