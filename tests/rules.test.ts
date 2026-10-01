import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMove, beats, deck, legalMoves, newGame, nextRound, power } from '../server/rules.js';
import { heuristic, observation } from '../server/agents.js';
import type { Card, Move } from '../shared/types.js';
const cards = (spec: [number, Card['suit']][]) =>
  spec.map(([rank, suit], i) => ({ id: `test-${i}`, rank, suit }));
test('108 unique cards and 27 per player', () => {
  assert.equal(deck().length, 108);
  assert.equal(new Set(deck().map((c) => c.id)).size, 108);
  const g = newGame();
  assert.deepEqual(
    g.hands.map((h) => h.length),
    [27, 27, 27, 27],
  );
});
test('level outranks A; jokers outrank level', () => {
  assert.ok(power(2, 2) > power(14, 2));
  assert.ok(power(15, 2) > power(2, 2));
});
test('wildcard substitutions cannot create joker pair', () => {
  const h = cards([
    [15, 'J'],
    [2, 'H'],
    [7, 'S'],
  ]);
  const moves = legalMoves(h, 2, null);
  assert.ok(!moves.some((m) => m.kind === 'pair' && m.strength === power(15, 2)));
  assert.ok(moves.some((m) => m.kind === 'pair' && m.strength === 7));
  assert.ok(!moves.some((m) => m.kind === 'pass'));
});
test('all sequence shapes, ace-low and flush wildcard', () => {
  assert.ok(
    legalMoves(
      cards([
        [14, 'S'],
        [2, 'S'],
        [3, 'S'],
        [4, 'S'],
        [5, 'S'],
      ]),
      9,
      null,
    ).some((m) => m.kind === 'flush' && m.strength === 5),
  );
  assert.ok(
    legalMoves(
      cards([
        [10, 'C'],
        [11, 'C'],
        [12, 'C'],
        [13, 'C'],
        [14, 'C'],
      ]),
      2,
      null,
    ).some((m) => m.kind === 'flush' && m.strength === 14),
  );
  assert.ok(
    legalMoves(
      cards([
        [3, 'D'],
        [4, 'D'],
        [5, 'D'],
        [6, 'D'],
        [2, 'H'],
      ]),
      2,
      null,
    ).some((m) => m.kind === 'flush' && Object.keys(m.substitutions ?? {}).length === 1),
  );
  assert.ok(
    !legalMoves(
      cards([
        [12, 'S'],
        [13, 'C'],
        [14, 'D'],
        [2, 'C'],
        [3, 'S'],
      ]),
      7,
      null,
    ).some((m) => m.kind === 'straight'),
  );
  const h = cards([
    [3, 'S'],
    [3, 'C'],
    [4, 'S'],
    [4, 'C'],
    [5, 'S'],
    [5, 'C'],
  ]);
  assert.ok(legalMoves(h, 2, null).some((m) => m.kind === 'pairs'));
  assert.ok(
    legalMoves(
      cards([
        [3, 'S'],
        [3, 'H'],
        [3, 'C'],
        [4, 'S'],
        [4, 'H'],
        [4, 'C'],
      ]),
      2,
      null,
    ).some((m) => m.kind === 'plate'),
  );
});
test('bomb hierarchy and ordinary type matching', () => {
  const m = (kind: Move['kind'], n: number, strength: number): Move => ({
    id: 'x',
    kind,
    cards: cards(Array.from({ length: n }, () => [4, 'S'])),
    strength,
    label: '',
  });
  assert.ok(beats(m('flush', 5, 5), m('bomb', 5, 14)));
  assert.ok(beats(m('bomb', 6, 3), m('flush', 5, 14)));
  assert.ok(beats(m('kings', 4, 100), m('bomb', 10, 16)));
  assert.ok(!beats(m('pair', 2, 14), m('single', 1, 2)));
  assert.ok(!beats(m('bomb', 4, 16), m('bomb', 5, 2)));
});
test('finished leader lends next trick to partner', () => {
  const g = newGame();
  g.hands = [
    cards([[3, 'S']]),
    cards([
      [2, 'C'],
      [4, 'C'],
    ]),
    cards([
      [5, 'S'],
      [6, 'S'],
    ]),
    cards([
      [2, 'D'],
      [7, 'D'],
    ]),
  ];
  applyMove(g, legalMoves(g.hands[0], 2, null).find((m) => m.strength === 3)!.id);
  assert.deepEqual(g.finished, [0]);
  for (let i = 0; i < 3; i++) applyMove(g, 'pass');
  assert.equal(g.turn, 2);
  assert.equal(g.last, null);
});
test('model observation excludes opponents private hands', () => {
  const g = newGame();
  const text = observation(g, legalMoves(g.hands[0], 2, null));
  const o = JSON.parse(text);
  assert.equal(o.hand.length, 27);
  assert.ok(!('hands' in o));
  assert.equal(o.counts.length, 4);
});
test('full strategy matches terminate and preserve cards across tribute', () => {
  for (let j = 0; j < 8; j++) {
    const g = newGame();
    g.status = 'running';
    let turns = 0;
    while (g.status === 'running' && turns < 2000) {
      const moves = legalMoves(g.hands[g.turn], g.level, g.last);
      assert.ok(moves.length);
      const chosen = heuristic(g, moves);
      applyMove(g, chosen.id);
      turns++;
    }
    assert.equal(g.status, 'round-over');
    assert.equal(new Set(g.finished).size, 4);
    assert.ok(turns < 2000);
    assert.ok(g.levels[g.winner!] >= 3);
    nextRound(g);
    assert.deepEqual(
      g.hands.map((h) => h.length),
      [27, 27, 27, 27],
    );
    assert.equal(new Set(g.hands.flat().map((c) => c.id)).size, 108);
  }
});
test('reject forged action without mutating hand', () => {
  const g = newGame();
  const before = JSON.stringify(g);
  assert.throws(() => applyMove(g, 'fake'));
  assert.equal(JSON.stringify(g), before);
});
test('A requires partner to finish second or third', () => {
  for (const order of [
    [0, 1],
    [0, 2],
    [0, 1, 2],
  ]) {
    const g = newGame();
    g.level = 14;
    g.levels = [14, 14];
    g.finished = order.slice(0, 2);
    g.turn = order[2] ?? [0, 1, 2, 3].find((s) => !g.finished.includes(s))!;
    g.hands = g.hands.map((_, s) =>
      g.finished.includes(s) ? [] : [{ id: `a-${s}`, rank: 3, suit: 'S' }],
    );
    applyMove(g, legalMoves(g.hands[g.turn], 14, null)[0].id);
    assert.equal(g.status, 'match-over');
  }
  const g = newGame();
  g.level = 14;
  g.levels = [14, 14];
  g.finished = [0, 1];
  g.turn = 3;
  g.hands = [[], [], cards([[8, 'C']]), cards([[4, 'S']])];
  applyMove(g, legalMoves(g.hands[3], 14, null)[0].id);
  assert.equal(g.status, 'round-over');
  assert.equal(g.levels[0], 14);
});
test('single tribute swaps highest non-wild and lowest eligible return', () => {
  const g = newGame();
  g.status = 'round-over';
  g.finished = [0, 1, 2, 3];
  const h = [
    cards([
      [3, 'S'],
      [9, 'C'],
    ]),
    cards([
      [7, 'C'],
      [8, 'S'],
    ]),
    cards([
      [5, 'C'],
      [6, 'S'],
    ]),
    cards([
      [16, 'J'],
      [2, 'H'],
      [4, 'C'],
    ]),
  ].map((hand, s) => hand.map((c) => ({ ...c, id: `${s}-${c.id}` })));
  nextRound(g, h);
  assert.equal(g.turn, 3);
  assert.ok(g.hands[0].some((c) => c.rank === 16));
  assert.ok(g.hands[3].some((c) => c.rank === 3));
  assert.ok(g.hands[3].some((c) => c.rank === 2 && c.suit === 'H'));
  assert.equal(g.tribute.length, 1);
});
test('double tribute anti-tribute with both big kings split across losing team', () => {
  const g = newGame();
  g.status = 'round-over';
  g.finished = [0, 2, 1, 3];
  const h = [
    cards([
      [3, 'S'],
      [9, 'C'],
    ]),
    cards([
      [16, 'J'],
      [8, 'S'],
    ]),
    cards([
      [5, 'C'],
      [6, 'S'],
    ]),
    cards([
      [16, 'J'],
      [7, 'C'],
    ]),
  ].map((hand, s) => hand.map((c) => ({ ...c, id: `${s}-${c.id}` })));
  const before = JSON.stringify(h);
  nextRound(g, h);
  assert.equal(g.turn, 0);
  assert.match(g.tribute[0], /抗贡/);
  assert.equal(JSON.stringify(g.hands), before);
});
test('double tribute larger offer goes to first finisher', () => {
  const g = newGame();
  g.status = 'round-over';
  g.finished = [0, 2, 1, 3];
  const h = [
    cards([
      [3, 'S'],
      [9, 'C'],
    ]),
    cards([
      [15, 'J'],
      [8, 'S'],
    ]),
    cards([
      [5, 'C'],
      [6, 'S'],
    ]),
    cards([
      [14, 'S'],
      [7, 'C'],
    ]),
  ].map((hand, s) => hand.map((c) => ({ ...c, id: `${s}-${c.id}` })));
  nextRound(g, h);
  assert.equal(g.turn, 1);
  assert.ok(g.hands[0].some((c) => c.rank === 15));
  assert.ok(g.hands[2].some((c) => c.rank === 14));
  assert.equal(g.tribute.length, 2);
});

test('same team takes first two places: settle immediately and upgrade three levels', () => {
  const g = newGame();
  g.finished = [0];
  g.turn = 2;
  g.hands[0] = [];
  g.hands[2] = [{ id: 'winner-last', rank: 4, suit: 'S' }];
  const opponents = g.hands[1].length + g.hands[3].length;
  applyMove(g, legalMoves(g.hands[2], 2, null)[0].id);
  assert.equal(g.status, 'round-over');
  assert.equal(g.levels[0], 5);
  assert.deepEqual(g.finished.slice(0, 2), [0, 2]);
  assert.equal(g.hands[1].length + g.hands[3].length, opponents);
});
test('upgrade table awards exactly 1, 2 or 3 levels', () => {
  for (const [prefix, seat, expected] of [
    [[0, 1], 3, 3],
    [[0, 1], 2, 4],
    [[0], 2, 5],
  ] as [number[], number, number][]) {
    const g = newGame();
    g.finished = prefix;
    g.turn = seat;
    g.hands[seat] = [{ id: 'finish', rank: 4, suit: 'S' }];
    applyMove(g, legalMoves(g.hands[seat], 2, null)[0].id);
    assert.equal(g.levels[0], expected);
  }
});
test('having reached A does not win a match while the current deal plays another level', () => {
  const g = newGame();
  g.level = 5;
  g.levels = [14, 5];
  g.finished = [0, 1];
  g.turn = 2;
  g.hands[2] = [{ id: 'a-finish', rank: 4, suit: 'S' }];
  applyMove(g, legalMoves(g.hands[2], 5, null)[0].id);
  assert.equal(g.status, 'round-over');
  nextRound(g);
  assert.equal(g.level, 14);
});
test('equal double tribute leads from first finisher next seat, independently of loser order', () => {
  for (let first = 0; first < 4; first++) {
    const partner = (first + 2) % 4,
      donorA = (first + 1) % 4,
      donorB = (first + 3) % 4;
    for (const donors of [
      [donorA, donorB],
      [donorB, donorA],
    ]) {
      const g = newGame();
      g.status = 'round-over';
      g.finished = [first, partner, ...donors];
      const hands = [0, 1, 2, 3].map((seat) => [
        { id: `low-${seat}`, rank: 4, suit: 'C' as const },
        { id: `high-${seat}`, rank: seat % 2 === first % 2 ? 9 : 14, suit: 'S' as const },
      ]);
      nextRound(g, hands);
      assert.equal(g.turn, (first + 1) % 4);
      assert.equal(g.tribute.length, 2);
      assert.equal(new Set(g.hands.flat().map((c) => c.id)).size, 8);
    }
  }
});
test('single donor with both big kings refuses tribute and first finisher leads', () => {
  const g = newGame();
  g.status = 'round-over';
  g.finished = [0, 1, 2, 3];
  const hands = [0, 1, 2, 3].map((seat) => [{ id: `card-${seat}`, rank: 4, suit: 'C' as const }]);
  hands[3] = [
    { id: 'big-1', rank: 16, suit: 'J' },
    { id: 'big-2', rank: 16, suit: 'J' },
  ] as any;
  const before = JSON.stringify(hands);
  nextRound(g, hands);
  assert.equal(g.turn, 0);
  assert.match(g.tribute[0], /抗贡/);
  assert.equal(JSON.stringify(g.hands), before);
});

test('complete multi-round strategy matches reach A without losing or duplicating cards', () => {
  for (let run = 0; run < 2; run++) {
    const g = newGame();
    g.status = 'running';
    let turns = 0;
    const status = () => g.status;
    while (status() !== 'match-over' && turns < 30000 && g.round < 200) {
      if (status() === 'round-over') {
        nextRound(g);
        assert.equal(g.hands.flat().length, 108);
        assert.equal(new Set(g.hands.flat().map((c) => c.id)).size, 108);
        assert.equal(g.level, g.levels[g.previous[0] % 2]);
        g.status = 'running';
      }
      applyMove(g, heuristic(g, legalMoves(g.hands[g.turn], g.level, g.last)).id);
      turns++;
    }
    assert.equal(g.status, 'match-over');
    assert.equal(g.level, 14);
    assert.equal(g.levels[g.winner!], 14);
    assert.ok(g.finished.indexOf((g.finished[0] + 2) % 4) <= 2);
  }
});
test('upgrade starts from the current deal level without demoting an earned higher level', () => {
  const g = newGame();
  g.level = 5;
  g.levels = [2, 5];
  g.finished = [0];
  g.turn = 2;
  g.hands[2] = [{ id: 'finish-current-level', rank: 4, suit: 'S' }];
  applyMove(g, legalMoves(g.hands[2], g.level, null)[0].id);
  assert.equal(g.levels[0], 8);
  assert.equal(g.settlement?.upgrade, 3);
  assert.equal(g.settlement?.to, 8);
});

test('three failed A attempts demote the attempting team, not necessarily the round winner', () => {
  for (const winner of [0, 1]) {
    const g = newGame();
    g.level = 14;
    g.levels = [14, winner === 0 ? 14 : 2];
    g.previous = [0, 1, 3, 2];
    g.aFailures = [2, 0];
    g.finished = winner === 0 ? [0, 1] : [1, 2];
    g.turn = 3;
    g.hands[3] = [{ id: 'failed-a', rank: 4, suit: 'S' }];
    applyMove(g, legalMoves(g.hands[3], g.level, null)[0].id);
    assert.equal(g.status, 'round-over');
    assert.equal(g.levels[0], 2);
    assert.equal(g.aFailures[0], 0);
    assert.equal(g.settlement?.failedA, 3);
    assert.equal(g.settlement?.demotedTeam, 0);
  }
});

test('first and second failed A attempts keep the team at A', () => {
  for (const failures of [0, 1]) {
    const g = newGame();
    g.level = 14;
    g.levels = [14, 2];
    g.previous = [0, 1, 3, 2];
    g.aFailures = [failures, 0];
    g.finished = [0, 1];
    g.turn = 3;
    g.hands[3] = [{ id: 'retry-a', rank: 4, suit: 'S' }];
    applyMove(g, legalMoves(g.hands[3], 14, null)[0].id);
    assert.equal(g.levels[0], 14);
    assert.equal(g.aFailures[0], failures + 1);
    assert.equal(g.settlement?.passedA, false);
  }
});

test('tribute ceremony exposes only the exchanged public cards and pauses the opening briefly', () => {
  const g = newGame();
  g.status = 'round-over';
  g.finished = [0, 1, 2, 3];
  // Guarantee single tribute rather than the randomly dealt anti-tribute case.
  g.hands = [
    [{ id: 'return', rank: 3, suit: 'S' }],
    [],
    [],
    [{ id: 'offer', rank: 13, suit: 'S' }],
  ];
  nextRound(g, g.hands);
  assert.equal(g.tributeKind, 'single');
  assert.deepEqual(
    g.tributeSteps?.map((s) => [s.donor, s.receiver, s.offered.id, s.returned.id]),
    [[3, 0, 'offer', 'return']],
  );
  assert.equal(g.turn, 3);
  assert.ok(g.tributeUntil! > Date.now());
});
