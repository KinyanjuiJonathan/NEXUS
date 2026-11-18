/** Default minutes without input before the Auto Typer screen returns to the dashboard. */
export const DEFAULT_IDLE_RETURN_MIN = 5;

/**
 * Whether the Auto Typer screen should hand back to the dashboard: only when
 * the option is on, nothing is being typed, and there has been no keyboard or
 * mouse input for the whole timeout.
 */
export function shouldLeaveTyper(o: { enabled: boolean; minutes: number; idleSeconds: number; busy: boolean }): boolean {
  if (!o.enabled || o.busy) return false;
  const minutes = Number.isFinite(o.minutes) && o.minutes > 0 ? o.minutes : DEFAULT_IDLE_RETURN_MIN;
  return o.idleSeconds >= minutes * 60;
}
