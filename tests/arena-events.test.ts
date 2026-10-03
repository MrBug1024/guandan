import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame } from '../server/rules.js';
import { defaults } from '../server/agents.js';
import { publicState } from '../server/public-state.js';
import { gameFrame, type Kind, type PublicGame } from '../shared/types.js';
import { actorMood, arenaSnapshot, selectArenaCue } from '../src/arena-events.js';

function fixture(): PublicGame {
  return publicState(newGame(), defaults, {
    thinking: null,
    delayMs: 1800,
    autoNext: true,
    nextRoundAt: null,
  });
}
function play(game: PublicGame, kind: Kind, seat = 1, count = 4) {
  const cards = Array.from({ length: count }, (_, index) => ({
    id: `public-${game.history.length}-${index}`,
    rank: 9,
    suit: 'S' as const,
  }));
  game.history.push({
    seq: game.history.length + 1,
    seat,
    text: '',
    source: 'AI',
    time: new Date().toISOString(),
    elapsedMs: 1,
    move: { id: 'move', kind, cards, label: `${kind} · 9`, strength: 9 },
    after: gameFrame(newGame()),
  });
}
test('joining a broadcast and repeated SSE snapshots never replay an old bomb', () => {
  const game = fixture();
  play(game, 'bomb');
  assert.equal(selectArenaCue(game), undefined);
  assert.equal(selectArenaCue(structuredClone(game), arenaSnapshot(game)), undefined);
});
test('king bombs and straight flushes produce epic public-card closeups', () => {
  for (const kind of ['kings', 'flush'] as const) {
    const game = fixture(),
      before = arenaSnapshot(game);
    play(game, kind);
    const cue = selectArenaCue(game, before)!;
    assert.equal(cue.intensity, 'epic');
    assert.deepEqual(cue.cards, game.history[0].move!.cards);
    assert.equal(actorMood(game, cue, 1), 'celebrate');
    assert.equal(actorMood(game, cue, 3), 'clap');
    assert.equal(actorMood(game, cue, 0), 'shocked');
  }
});
test('an opponent bomb counter escalates the highlight, passing does not', () => {
  const game = fixture();
  play(game, 'bomb', 0);
  play(game, 'pass', 3, 0);
  const before = arenaSnapshot(game);
  play(game, 'bomb', 1, 5);
  assert.equal(selectArenaCue(game, before)?.eyebrow, 'POWER COUNTER');
  const after = arenaSnapshot(game);
  play(game, 'pass', 2, 0);
  assert.equal(selectArenaCue(game, after), undefined);
});
test('settlement wins over the final bomb and gives both partners the correct mood', () => {
  const game = fixture(),
    before = arenaSnapshot(game);
  play(game, 'kings', 3);
  game.status = 'round-over';
  game.winner = 1;
  game.finished = [3, 1, 0, 2];
  game.settlement = {
    team: 1,
    partnerPlace: 2,
    upgrade: 3,
    from: 2,
    to: 5,
    passedA: false,
    failedA: 0,
  };
  const cue = selectArenaCue(game, before)!;
  assert.equal(cue.kind, 'settlement');
  assert.equal(cue.duration, 10_000);
  assert.equal(cue.subtitle, '连升 3 级 · 2 → 5');
  assert.deepEqual(
    [0, 1, 2, 3].map((seat) => actorMood(game, cue, seat)),
    ['sad', 'celebrate', 'sad', 'celebrate'],
  );
  assert.equal(selectArenaCue(game, arenaSnapshot(game)), undefined);
});
test('a viewer joining settlement sees the celebration and champions get the A result', () => {
  const game = fixture();
  game.status = 'match-over';
  game.winner = 0;
  game.finished = [2, 1, 0, 3];
  game.settlement = {
    team: 0,
    partnerPlace: 3,
    upgrade: 0,
    from: 14,
    to: 14,
    passedA: true,
    failedA: 0,
  };
  assert.equal(selectArenaCue(game)?.title, '巅峰夺冠');
  assert.equal(selectArenaCue(game)?.duration, 12_000);
  assert.equal(actorMood(game, undefined, 2), 'celebrate');
});
test('only an unexpired tribute ceremony plays, including anti tribute', () => {
  const game = fixture();
  game.round = 2;
  game.tributeKind = 'anti';
  game.tributeUntil = 5000;
  game.previous = [0, 2, 1, 3];
  const cue = selectArenaCue(game, undefined, 2000)!;
  assert.equal(cue.kind, 'tribute');
  assert.equal(cue.duration, 3000);
  assert.equal(actorMood(game, cue, 1), 'proud');
  assert.equal(actorMood(game, cue, 0), 'shocked');
  assert.equal(selectArenaCue(game, undefined, 6000), undefined);
});
test('single and double tribute donors bow and receivers acknowledge', () => {
  for (const kind of ['single', 'double'] as const) {
    const game = fixture();
    game.round = 2;
    game.tributeKind = kind;
    game.tributeUntil = 5000;
    const card = { id: 'tribute-public', rank: 14, suit: 'S' as const };
    game.tributeSteps = [
      { donor: 3, receiver: 0, offered: card, returned: { ...card, id: 'return-public', rank: 4 } },
    ];
    if (kind === 'double')
      game.tributeSteps.push({ donor: 1, receiver: 2, offered: card, returned: card });
    const cue = selectArenaCue(game, undefined, 1000)!;
    for (const step of game.tributeSteps) {
      assert.equal(actorMood(game, cue, step.donor), 'bow');
      assert.equal(actorMood(game, cue, step.receiver), 'proud');
    }
  }
});
test('single anti tribute celebrates the last finisher even when their partner took first', () => {
  const game = fixture();
  game.round = 2;
  game.tributeKind = 'anti';
  game.tributeUntil = 5000;
  game.previous = [0, 1, 3, 2];
  const cue = selectArenaCue(game, undefined, 1000)!;
  assert.equal(actorMood(game, cue, 2), 'proud');
  assert.equal(actorMood(game, cue, 0), 'proud');
  assert.equal(actorMood(game, cue, 1), 'shocked');
});
test('finish and final-card alarms fire once at their transition', () => {
  const game = fixture();
  const before = arenaSnapshot(game);
  play(game, 'single');
  game.counts[1] = 3;
  assert.equal(selectArenaCue(game, before)?.kind, 'alarm');
  const after = arenaSnapshot(game);
  play(game, 'single');
  game.counts[1] = 2;
  assert.equal(selectArenaCue(game, after), undefined);
  const final = arenaSnapshot(game);
  play(game, 'pair');
  game.counts[1] = 0;
  game.finished = [1];
  assert.equal(selectArenaCue(game, final)?.title, '头游诞生！');
});
test('rewinding replay or resetting a game discards historical effects', () => {
  const game = fixture();
  play(game, 'bomb');
  const before = arenaSnapshot(game);
  game.history = [];
  assert.equal(selectArenaCue(game, before), undefined);
  game.id = 'reset';
  play(game, 'bomb');
  assert.equal(selectArenaCue(game, before), undefined);
});
test('wind event identifies the partner and takes precedence over a pass', () => {
  const game = fixture(),
    before = arenaSnapshot(game);
  play(game, 'pass', 1, 0);
  game.wind = { from: 0, seat: 2, at: 1234 };
  const cue = selectArenaCue(game, before)!;
  assert.equal(cue.kind, 'wind');
  assert.equal(cue.seat, 2);
  assert.equal(actorMood(game, cue, 2), 'proud');
});
