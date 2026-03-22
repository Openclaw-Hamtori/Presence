/**
 * Automatic background measurement / linked proof retry is disabled for the
 * on-demand linked-service flow. Proof now runs only from explicit user action.
 */

// INTENTIONAL_FORK: test app disables background scheduling for the on-demand linked-service flow.

import { useEffect } from "react";
import type { UsePresenceStateResult } from "./usePresenceState";

type ScheduledTask = () => Promise<boolean | void>;

export function usePresenceBackgroundSync(
  _presence: UsePresenceStateResult,
  _runScheduledTask: ScheduledTask
): void {
  useEffect(() => undefined, []);
}
