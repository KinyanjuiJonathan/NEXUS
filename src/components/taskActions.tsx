import { nexus } from "@/store";
import { choose } from "./Confirm";

const MIN = 60_000;

/** Ask how much more time a task's block should get, and give it. */
export async function askExtend(eventId: string, title: string) {
  const pick = await choose({
    title: "Extend this task",
    body: (
      <>
        How much more time does <b className="text-fg">“{title}”</b> need? The tasks after it move along by the same amount, in the same order. Fixed appointments stay where they are.
      </>
    ),
    choices: [
      { value: "15", label: "+15 min", variant: "soft" },
      { value: "30", label: "+30 min", variant: "soft" },
      { value: "60", label: "+1 hour", variant: "primary" },
      { value: "120", label: "+2 hours", variant: "soft" },
      { value: "180", label: "+3 hours", variant: "soft" },
    ],
  });
  if (pick) await nexus().extendTask(eventId, Number(pick) * MIN);
}

/** A task that ran out of time and is overdue: ask how much more it needs, counted from now. */
export async function askMoreTime(taskId: string, title: string) {
  const pick = await choose({
    title: "Give this task more time",
    body: (
      <>
        <b className="text-fg">“{title}”</b> ran out of time. How much more does it need, starting now? It stops being overdue, and the tasks after it move along in the same order.
      </>
    ),
    choices: [
      { value: "15", label: "+15 min", variant: "soft" },
      { value: "30", label: "+30 min", variant: "soft" },
      { value: "60", label: "+1 hour", variant: "primary" },
      { value: "120", label: "+2 hours", variant: "soft" },
      { value: "180", label: "+3 hours", variant: "soft" },
    ],
  });
  if (pick) await nexus().giveMoreTime(taskId, Number(pick) * MIN);
}

/** Ask where one more session of a task should go, and add it. */
export async function askRepeat(taskId: string, title: string, done: boolean) {
  const pick = await choose({
    title: done ? "Repeat this task" : "Add one more session",
    body: (
      <>
        <b className="text-fg">“{title}”</b> {done ? "is finished. It will be added again as a new task" : "gets another session"}, as long as its last one.
        <br />
        <b className="text-fg">Right after</b> puts it straight after its current time (or now) and moves later tasks along. <b className="text-fg">Next free time</b> finds a gap and moves nothing.
      </>
    ),
    choices: [
      { value: "after", label: "Right after", variant: "primary" },
      { value: "free", label: "Next free time", variant: "soft" },
    ],
  });
  if (pick) await nexus().repeatTask(taskId, pick as "after" | "free");
}
