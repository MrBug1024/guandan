import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimedPresenter } from '../src/timed-presenter.js';

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const jobs = new Map<number, { at: number; callback: () => void }>();
  const clock = {
    now: () => now,
    schedule: (callback: () => void, delayMs: number) => {
      const id = ++nextId;
      jobs.set(id, { at: now + delayMs, callback });
      return id;
    },
    cancel: (id: unknown) => jobs.delete(id as number),
    advance: (elapsedMs: number) => {
      const target = now + elapsedMs;
      while (true) {
        const due = [...jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!due || due[1].at > target) break;
        jobs.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
  };
  return clock;
}

test('insights hold for three seconds and replace only with the latest queued insight', () => {
  const clock = fakeClock();
  const visible: Array<string | null> = [];
  const presenter = createTimedPresenter((value: string | null) => visible.push(value), {
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  presenter.show('first');
  clock.advance(400);
  presenter.show('second');
  clock.advance(500);
  presenter.show('third');
  clock.advance(2099);
  assert.deepEqual(visible, ['first']);

  clock.advance(1);
  assert.deepEqual(visible, ['first', 'third']);
  clock.advance(3999);
  assert.deepEqual(visible, ['first', 'third']);
  clock.advance(1);
  assert.deepEqual(visible, ['first', 'third', null]);
});

test('a queued insight can be replaced immediately after the minimum hold', () => {
  const clock = fakeClock();
  const visible: Array<string | null> = [];
  const presenter = createTimedPresenter((value: string | null) => visible.push(value), {
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  presenter.show('first');
  clock.advance(3200);
  presenter.show('second');
  assert.deepEqual(visible, ['first', 'second']);
  presenter.clear();
  assert.deepEqual(visible, ['first', 'second', null]);
});
