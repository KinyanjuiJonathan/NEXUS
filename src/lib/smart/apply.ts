import type { NexusState } from "@/store/store";
import { nextContext, planTurn, type ConvContext, type Entity, type Turn, type TurnEnv } from "./converse";

/** What the scheduler needs to know from the app's state right now. */
export function turnEnv(s: NexusState, now: number): TurnEnv {
  return {
    now,
    tasks: s.tasks,
    events: s.events,
    slot: s.slotSettings(),
    defaultZone: s.settings.smartZone === "home" ? s.settings.homeZone : s.settings.smartZone,
    texasZone: s.settings.texasZone,
  };
}

/**
 * Carry out a planned turn against the store, in order, and return the
 * conversation context for the next message. Everything goes through the same
 * store actions as the rest of the app, so every view updates together.
 */
export async function applyTurn(turn: Turn, s: NexusState, ctx: ConvContext): Promise<ConvContext> {
  return (await applyTurnWithIds(turn, s, ctx)).context;
}

/** As `applyTurn`, also returning which saved entry each new activity became. */
export async function applyTurnWithIds(turn: Turn, s: NexusState, ctx: ConvContext): Promise<{ context: ConvContext; ids: Record<string, Entity> }> {
  const ids: Record<string, Entity> = {};
  for (const a of turn.actions) {
    if (a.type === "create") {
      const { event } = await s.smartCreate(a.req, a.slot, a.durationMin, { existingTaskId: a.existingTaskId });
      ids[a.tempId] = { kind: "event", id: event.id, title: event.title };
    } else if (a.type === "move") {
      await s.updateEvent(a.eventId, { startAt: a.to.start, endAt: a.to.end });
    } else {
      await s.updateEvent(a.eventId, { fixed: a.fixed });
    }
  }
  return { context: nextContext(ctx, turn, ids), ids };
}

export { planTurn };
