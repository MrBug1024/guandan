import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableCall, tableVoiceText } from '../shared/voice-lines.js';
import type { Move } from '../shared/types.js';

function move(kind: Move['kind'], rank = 13): Move {
  return {
    id: kind,
    kind,
    cards: [{ id: 'card', rank, suit: 'S' }],
    strength: rank,
    label: kind,
  };
}

test('table calls distinguish a deliberate pass from a forced pass and name key shapes', () => {
  assert.equal(tableCall(move('pass'), true), '不要');
  assert.equal(tableCall(move('pass')), '要不起');
  assert.equal(tableCall(move('pair')), '对K');
  assert.equal(tableCall(move('plate')), '钢板');
  assert.equal(tableCall(move('kings')), '王炸');
});

test('only model reads in high-pressure public situations are spoken after the move call', () => {
  const entry = {
    seat: 0,
    move: move('pair'),
    voiceLine: '对K',
    after: { counts: [10, 2, 8, 9], lastSeat: 0 },
    decision: { method: 'model', tacticalRead: '对手只剩两张，需要控制牌权。' },
  };
  assert.equal(tableVoiceText(entry), '对K。对手只剩两张，需要控制牌权。');
  assert.equal(tableVoiceText({ ...entry, decision: { method: 'heuristic', tacticalRead: '本地规则说明' } }), '对K');
  assert.equal(tableVoiceText({ ...entry, after: { counts: [10, 8, 8, 9], lastSeat: 0 } }), '对K');
});

test('public tribute events have short table calls', () => {
  assert.equal(tableVoiceText({ seat: -1, after: { counts: [10, 10, 10, 10], lastSeat: 0, tributeKind: 'anti' } }), '双王抗贡');
  assert.equal(tableVoiceText({ seat: -1, after: { counts: [10, 10, 10, 10], lastSeat: 0, tributeKind: 'double' } }), '进贡开始');
});
