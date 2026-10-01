import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicState } from '../server/public-state.js';
import { newGame, legalMoves, applyMove } from '../server/rules.js';
import { defaults } from '../server/agents.js';
const settings = { thinking: null, delayMs: 1800, autoNext: true, nextRoundAt: null };
test('spectator sees exactly the near player hand, never the other three', () => {
  const game = newGame(),
    state = publicState(game, defaults, settings);
  assert.equal(state.viewpointSeat, 0);
  assert.deepEqual(state.visibleHand, game.hands[0]);
  assert.equal('hands' in state, false);
  const payload = JSON.stringify(state);
  for (const hand of game.hands.slice(1))
    for (const card of hand) assert.equal(payload.includes(card.id), false);
  assert.deepEqual(state.counts, [27, 27, 27, 27]);
});
test('near-side hand updates after an actual legal play', () => {
  const game = newGame();
  const move = legalMoves(game.hands[0], 2, null).find((m) => m.kind === 'single')!;
  applyMove(game, move.id);
  const state = publicState(game, defaults, settings);
  assert.equal(state.visibleHand.length, 26);
  assert.ok(!state.visibleHand.some((c) => c.id === move.cards[0].id));
  assert.equal(state.counts[0], 26);
});
