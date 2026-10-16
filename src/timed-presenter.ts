export interface TimedPresenterOptions {
  minimumMs?: number;
  visibleMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export function createTimedPresenter<T>(
  publish: (value: T | null) => void,
  options: TimedPresenterOptions = {},
) {
  const minimumMs = options.minimumMs ?? 3000;
  const visibleMs = options.visibleMs ?? 4000;
  if (minimumMs < 0 || visibleMs < minimumMs)
    throw new RangeError('visibleMs must be greater than or equal to minimumMs');

  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let active: T | null = null;
  let activeSince = 0;
  let pending: T | undefined;
  let timer: unknown;

  function clearTimer() {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  }

  function arm(delayMs: number) {
    clearTimer();
    timer = schedule(() => {
      timer = undefined;
      if (pending !== undefined) {
        const elapsed = now() - activeSince;
        if (elapsed < minimumMs) {
          arm(minimumMs - elapsed);
          return;
        }
        const next = pending;
        pending = undefined;
        begin(next);
        return;
      }
      active = null;
      activeSince = 0;
      publish(null);
    }, delayMs);
  }

  function begin(value: T) {
    clearTimer();
    active = value;
    activeSince = now();
    pending = undefined;
    publish(value);
    arm(visibleMs);
  }

  return {
    show(value: T) {
      if (active === null) {
        begin(value);
        return;
      }
      const remaining = minimumMs - (now() - activeSince);
      if (remaining <= 0) begin(value);
      else {
        pending = value;
        arm(remaining);
      }
    },
    clear() {
      clearTimer();
      pending = undefined;
      active = null;
      activeSince = 0;
      publish(null);
    },
  };
}
