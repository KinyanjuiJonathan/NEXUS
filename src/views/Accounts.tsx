import { useEffect } from "react";
import { LogOut } from "lucide-react";
import { getBackend } from "@/store";
import { Button } from "@/components/ui";
import { accounts, useAccounts } from "@/accounts/useAccounts";
import { AdminHome } from "@/accounts/ui/Admin";
import { SignIn } from "@/accounts/ui/SignIn";
import { TaskerHome } from "@/accounts/ui/Tasker";

/**
 * Accounts: the accounts managed for other people, the taskers who work on
 * them, the tasks they are given at a rate, and the money that follows.
 * Nothing is shown until someone signs in; leaving the screen signs out.
 */
export default function Accounts() {
  const { ready, session } = useAccounts((s) => ({ ready: s.ready, session: s.session }));

  useEffect(() => {
    void accounts().load();
    // another window (or a restore) changed the stored records
    const off = getBackend().onDataChanged((entity) => (entity === "records" || entity === "all") && void accounts().load());
    return () => {
      off();
      accounts().signOut(); // walking away from the screen locks it again
    };
  }, []);

  if (!ready) return <div className="h-40 rounded-2xl shimmer" />;
  if (!session) return <SignIn />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Accounts</h1>
          <p className="text-sm text-muted">{session.role === "admin" ? "Signed in as the manager." : "Signed in to the taskers' side."}</p>
        </div>
        <Button variant="outline" icon={<LogOut size={15} />} onClick={() => accounts().signOut()}>Sign out</Button>
      </div>
      {session.role === "admin" ? <AdminHome /> : <TaskerHome personId={session.personId} />}
    </div>
  );
}
