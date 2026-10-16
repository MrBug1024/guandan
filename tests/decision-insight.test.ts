import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyActionUpdate, makeDecisionInsight } from '../src/decision-insight.js';
import type { Move, PublicEntry } from '../shared/types.js';

function entry(overrides: Partial<PublicEntry> = {}): PublicEntry {
  const move: Move = {
    id: 'pass',
    kind: 'pass',
    cards: [],
    strength: 0,
    label: '不出',
  };
  return {
    seq: 7,
    seat: 2,
    text: '不出',
    move,
    source: 'model',
    elapsedMs: 200,
    time: new Date(0).toISOString(),
    ...overrides,
  };
}

test('routine model explanations are eligible and retain deliberate pass wording', () => {
  const insight = makeDecisionInsight(
    entry({ voiceLine: '不要' }),
    { method: 'model', rationale: '队友已经控制牌权，我先保留手牌结构。' },
    '桃桃',
    0,
  );

  assert.equal(insight?.moment, 'routine');
  assert.equal(insight?.action, '不要');
  assert.equal(insight?.slot, 'top');
  assert.equal(insight?.partner, true);
});

test('repeated SSE snapshots preserve the same action; only a new action advances the presenter', () => {
  const current = { gameId: 'g1', round: 3, seq: 12 };
  assert.equal(classifyActionUpdate(current, current), 'unchanged');
  assert.equal(classifyActionUpdate({ ...current, seq: 13 }, current), 'advance');
  assert.equal(classifyActionUpdate({ ...current, round: 4, seq: 1 }, current), 'reset');
  assert.equal(classifyActionUpdate({ ...current, seq: 2 }, current), 'reset');
});

test('forced pass wording is preserved and unavailable/private reasoning is not fabricated', () => {
  const forced = makeDecisionInsight(
    entry({ voiceLine: '要不起' }),
    { method: 'model', rationale: '没有合法的跟牌动作。', moment: 'critical' },
    '桃桃',
    0,
  );
  assert.equal(forced?.action, '要不起');

  assert.equal(makeDecisionInsight(entry(), undefined, '桃桃', 0), null);
  assert.equal(
    makeDecisionInsight(
      entry(),
      { method: 'heuristic', rationale: '本地规则提示' } as PublicEntry['decision'],
      '桃桃',
      0,
    ),
    null,
  );
});
