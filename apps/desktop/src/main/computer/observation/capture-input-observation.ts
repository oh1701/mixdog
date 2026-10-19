/**
 * The input observer's view around a capture: the bounded read of its monitor
 * and sequence, and whether the two reads bracketing a capture prove the
 * foreground stayed untouched.
 */
import type { ComputerCommand, ComputerInputObservation } from '../shared/types';
import { CAPTURE_ACCESSIBILITY_TIMEOUT_MS } from '../shared/common';

export interface InputObservationHost {
  callPowerShell(
    request: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>;
  sessionIdFor(command: ComputerCommand): string;
  assertExecutionNotAborted(): void;
}

export function createInputObservationReader(
  host: InputObservationHost,
  command: ComputerCommand,
  targetWindowId: () => string = () => ''
) {
  return async (): Promise<ComputerInputObservation | undefined> => {
    host.assertExecutionNotAborted();
    const windowId = process.platform === 'darwin' ? targetWindowId() : '';
    try {
      const response = await host.callPowerShell(
        {
          action: 'input_idle_state',
          session_id: host.sessionIdFor(command),
          read_only: true,
          ...(windowId ? { window_id: windowId } : {}),
        },
        CAPTURE_ACCESSIBILITY_TIMEOUT_MS
      );
      host.assertExecutionNotAborted();
      const result = response.result;
      if (
        !response.ok ||
        typeof result?.monitor !== 'string' ||
        !result.monitor ||
        !Number.isSafeInteger(result.sequence) ||
        Number(result.sequence) < 0
      )
        return undefined;
      const target = result.target_observation as Record<string, unknown> | undefined;
      return {
        ready: result.observer_ready === true,
        monitor: result.monitor,
        sequence: Number(result.sequence),
        ...(windowId && target
          ? {
              target: {
                ready:
                  target.ready === true &&
                  target.window_id === windowId &&
                  typeof target.monitor === 'string' &&
                  target.monitor.length > 0 &&
                  Number.isSafeInteger(target.sequence) &&
                  Number(target.sequence) >= 0,
                monitor: typeof target.monitor === 'string' ? target.monitor : '',
                sequence: Number(target.sequence),
                windowId: String(target.window_id || ''),
                ...(typeof target.reason === 'string' ? { reason: target.reason } : {}),
              },
            }
          : {}),
      };
    } catch {
      host.assertExecutionNotAborted();
      return undefined;
    }
  };
}

/** Unrelated desktop activity may invalidate foreground authority, never the
 * target's background authority. Missing or changed attribution fails closed. */
export function assertTargetInputUnchanged(
  before: ComputerInputObservation | undefined,
  after: ComputerInputObservation | undefined
): void {
  const first = before?.target;
  const last = after?.target;
  if (!first?.ready || !last?.ready || first.monitor !== last.monitor || first.windowId !== last.windowId) {
    throw new Error(
      `target_input_observation_unavailable: ${last?.reason || first?.reason || 'target input attribution cannot be established'}; capture a fresh target observation`
    );
  }
  if (first.sequence !== last.sequence) {
    throw new Error('user_input_active: user input changed in the controlled app during capture');
  }
}

export function foregroundInputState(
  before: ComputerInputObservation | undefined,
  after: ComputerInputObservation | undefined
): { foregroundReady: boolean; foregroundInputReason?: string } {
  const foregroundReady =
    before?.ready === true &&
    after?.ready === true &&
    before.monitor === after.monitor &&
    before.sequence === after.sequence;
  if (foregroundReady) return { foregroundReady };
  return {
    foregroundReady,
    foregroundInputReason:
      before?.ready !== true || after?.ready !== true ? 'input_observer_unavailable' : 'user_input_during_capture',
  };
}
