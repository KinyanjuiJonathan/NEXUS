import { nexus } from "@/store";
import { confirm } from "./Confirm";

/** Tasks whose confirmation is on screen, so a double click can't complete twice. */
const asking = new Set<string>();

/**
 * The only way a task is marked complete from the main window: ask first.
 * "Confirm Completion" completes it, records the time and offers Undo; Cancel
 * (or Esc) leaves the task exactly as it was. Returns whether it was completed.
 */
export async function confirmComplete(taskId: string): Promise<boolean> {
  const task = nexus().tasks.find((t) => t.id === taskId);
  if (!task || task.deletedAt || task.status === "done" || asking.has(taskId)) return false;
  asking.add(taskId);
  try {
    const ok = await confirm({
      title: "Mark as completed?",
      body: (
        <>
          Are you sure you want to mark <b className="text-fg">“{task.title}”</b> as completed?
        </>
      ),
      confirmLabel: "Confirm Completion",
    });
    if (!ok) return false;
    await nexus().setTaskDone(taskId, true);
    nexus().toast({ kind: "success", title: "Completed ✓", body: task.title, action: { label: "Undo", run: () => void nexus().setTaskDone(taskId, false) }, ttl: 8000 });
    return true;
  } finally {
    asking.delete(taskId);
  }
}
