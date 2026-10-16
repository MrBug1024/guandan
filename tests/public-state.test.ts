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
test('public decision trace exposes only rationale and tactical read', () => {
  const game = newGame();
  const candidates = legalMoves(game.hands[0], game.level, null);
  game.history.push({
    seq: 1,
    seat: 0,
    text: '公开说明',
    move: candidates[0]!,
    source: 'test-model',
    elapsedMs: 10,
    time: new Date().toISOString(),
    decision: {
      method: 'model',
      candidateSource: 'model-shortlist',
      candidateCount: 1,
      legalActionCount: 17,
      candidates: [{ index: 0, moveId: 'private-id', kind: candidates[0]!.kind, label: '私有候选牌面', cardCount: 1, strength: 4 }],
      choiceIndex: 0,
      selectedMoveId: candidates[0]!.id,
      rationale: '公开说明',
      tacticalRead: '可能在等待搭档信号',
      moment: 'tactical',
    },
  });
  const payload = JSON.stringify(publicState(game, defaults, settings));
  assert.match(payload, /可能在等待搭档信号/);
  assert.match(payload, /"moment":"tactical"/);
  assert.doesNotMatch(payload, /私有候选牌面|private-id|candidateCount|legalActionCount|choiceIndex/);
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

test('each selected viewpoint exposes only that seat private hand', () => {
  const game = newGame();
  for (let seat = 0; seat < 4; seat++) {
    const state = publicState(game, defaults, { ...settings, viewpointSeat: seat });
    assert.equal(state.viewpointSeat, seat);
    assert.deepEqual(state.visibleHand, game.hands[seat]);
    assert.equal('hands' in state, false);
    const payload = JSON.stringify(state);
    game.hands.forEach((hand, i) => {
      if (i !== seat) hand.forEach((card) => assert.equal(payload.includes(card.id), false));
    });
  }
});
