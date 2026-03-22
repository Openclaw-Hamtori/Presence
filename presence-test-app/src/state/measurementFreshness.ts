export const SCHEDULED_CHECK_LEAD_SECONDS = 60;

export interface ReusablePassStateSnapshot {
  pass: boolean;
  stateValidUntil: number;
}

export interface FreshMeasurementSnapshot {
  pass: boolean;
  stateCreatedAt: number;
  stateValidUntil: number;
}

export function canReuseMeasuredPassState(
  state: ReusablePassStateSnapshot | null | undefined,
  capturedAt: number
): boolean {
  if (!state?.pass) return false;

  const remaining = state.stateValidUntil - capturedAt;
  return remaining > SCHEDULED_CHECK_LEAD_SECONDS;
}

export function isFreshMeasurementSnapshot(
  state: FreshMeasurementSnapshot | null | undefined,
  capturedAt: number
): boolean {
  if (!state?.pass) return false;

  return state.stateCreatedAt === capturedAt && state.stateValidUntil > capturedAt;
}
