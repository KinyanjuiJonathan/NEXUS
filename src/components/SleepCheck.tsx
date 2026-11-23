import { BedDouble } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { formatTime } from "@/lib/time";
import { hoursMinutes } from "@/lib/countdown";
import { Button, Modal } from "./ui";

/**
 * After four hours or more with no activity: was that sleep? Nothing is
 * assumed. "Yes" makes that stretch the sleep, so the day starts now (admin
 * and planning first); "No" leaves the plan as it was.
 */
export function SleepCheckDialog() {
  const { check, settings } = useNexus((s) => ({ check: s.sleepCheck, settings: s.settings }));
  const answer = (a: "sleep" | "sleep+breakfast" | "no") => void nexus().answerSleepCheck(a);
  const t = (ms: number) => formatTime(ms, settings.homeZone, settings.hour12);
  return (
    <Modal
      open={!!check}
      onClose={() => answer("no")}
      title="Welcome back. Were you asleep?"
      icon={<BedDouble size={18} />}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={() => answer("no")} className="mr-auto">No, leave my plan</Button>
          <Button variant="soft" onClick={() => answer("sleep")}>Yes, that was my sleep</Button>
          <Button variant="primary" onClick={() => answer("sleep+breakfast")}>Sleep and breakfast</Button>
        </>
      }
    >
      {check && (
        <div className="flex flex-col gap-3 text-sm text-fg-2">
          <p>
            There was no activity for <b className="text-fg">{hoursMinutes(check.to - check.from)}</b>, from <b className="text-fg">{t(check.from)}</b> to <b className="text-fg">{t(check.to)}</b>.
          </p>
          <p>Should that time be taken off your planned sleep{settings.routine.breakfastMin > 0 ? " and breakfast" : ""}?</p>
          <ul className="text-[12px] text-muted list-disc pl-5 space-y-1">
            <li><b className="text-fg-2">Yes</b>: it counts as your sleep. Your day starts now: admin and planning first, then the rest of your tasks in order, fitted into the time you have.</li>
            <li><b className="text-fg-2">Sleep and breakfast</b>: the same, and breakfast is counted as done.</li>
            <li><b className="text-fg-2">No</b>: nothing changes.</li>
          </ul>
        </div>
      )}
    </Modal>
  );
}
