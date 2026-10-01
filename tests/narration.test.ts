import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spokenMove } from '../server/narration.js';
import type { Move } from '../shared/types.js';

const move = (kind: Move['kind'], ranks: number[], substitutions?: Record<string, number>): Move => ({
  kind, id: 'test', strength: 1, label: '♠J ♥Q ♦K A', substitutions,
  cards: ranks.map((rank, i) => ({ id: String(i), rank, suit: 'H' })),
});
test('spoken cards use Chinese names instead of visual symbols and English letters', () => {
  assert.equal(spokenMove('桃桃', move('pair', [3, 3])), '桃桃打出一对三。');
  assert.equal(spokenMove('团子', move('single', [14])), '团子打出红桃尖。');
  assert.equal(spokenMove('芒果'), '芒果选择不出。');
  for (const rank of [11, 12, 13, 14]) assert.doesNotMatch(spokenMove('桃桃', move('single', [rank])), /[A-Za-z♠♥♦♣]/);
});
test('full house narration explains the actual wildcard assignment', () => {
  assert.equal(spokenMove('蓝莓', move('fullhouse', [2, 3, 3, 12, 12], { '0': 3 })), '蓝莓打出三个三带一对圈。');
  assert.equal(spokenMove('团子', move('kings', [15, 15, 16, 16])), '团子打出四大天王。');
});
