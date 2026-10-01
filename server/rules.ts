import { randomInt, randomUUID } from 'node:crypto';
import { cardName, rankName, type Card, type Game, type Kind, type Move } from '../shared/types.js';
export const power = (r: number, level: number) => (r >= 15 ? r + 2 : r === level ? 16 : r);
export const wild = (c: Card, l: number) => c.suit === 'H' && c.rank === l;
const names: Record<Kind, string> = {
  single: '单张',
  pair: '对子',
  triple: '三张',
  fullhouse: '三带二',
  straight: '顺子',
  pairs: '三连对',
  plate: '钢板',
  bomb: '炸弹',
  flush: '同花顺',
  kings: '四王',
  pass: '不出',
};
export function deck(): Card[] {
  return [0, 1].flatMap((d) => [
    ...(['S', 'H', 'C', 'D'] as const).flatMap((s) =>
      Array.from({ length: 13 }, (_, i) => ({ id: `${d}-${s}-${i + 2}`, rank: i + 2, suit: s })),
    ),
    ...([15, 16] as const).map((rank) => ({ id: `${d}-J-${rank}`, rank, suit: 'J' as const })),
  ]);
}
export function deal(): Card[][] {
  const cards = deck();
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return Array.from({ length: 4 }, (_, i) => cards.slice(i * 27, i * 27 + 27));
}
export function beats(a: Move, b: Move | null): boolean {
  if (a.kind === 'pass') return !!b;
  if (!b) return true;
  const tier = (m: Move) =>
    m.kind === 'kings'
      ? 100
      : m.kind === 'bomb'
        ? m.cards.length >= 6
          ? m.cards.length + 10
          : m.cards.length
        : m.kind === 'flush'
          ? 5.5
          : 0;
  const at = tier(a),
    bt = tier(b);
  return at !== bt
    ? at > bt
    : at > 0
      ? a.cards.length === b.cards.length && a.strength > b.strength
      : a.kind === b.kind && a.strength > b.strength;
}
/** Enumerate rank-pattern interpretations, including every natural/wildcard allocation.
 * Identical copies and equivalent suits are canonicalized; flushes retain suit semantics. */
export function legalMoves(hand: Card[], level: number, last: Move | null): Move[] {
  const out = new Map<string, Move>();
  const ws = hand.filter((c) => wild(c, level)).sort((a, b) => a.id.localeCompare(b.id));
  const natural = hand.filter((c) => !wild(c, level));
  function add(
    kind: Kind,
    cards: Card[],
    strength: number,
    substitutions: Record<string, number> = {},
  ) {
    const ids = cards.map((c) => c.id).sort();
    const id = `${kind}:${strength}:${ids.join(',')}`;
    const m: Move = {
      id,
      kind,
      cards: [...cards],
      strength,
      label: `${names[kind]} · ${cards.map(cardName).join(' ')}`,
      substitutions,
    };
    if (beats(m, last)) out.set(id, m);
  }
  function pattern(kind: Kind, needs: [number, number][], strength: number, suit?: Card['suit']) {
    function fill(i: number, used: Card[], usedWild: number, subs: Record<string, number>) {
      if (i === needs.length) {
        add(kind, used, strength, subs);
        return;
      }
      const [rank, count] = needs[i];
      const pool = natural
        .filter((c) => c.rank === rank && (!suit || c.suit === suit))
        .sort((a, b) => a.id.localeCompare(b.id));
      for (
        let n = Math.min(count, pool.length);
        n >= Math.max(0, count - (ws.length - usedWild));
        n--
      ) {
        const w = count - n;
        if (rank >= 15 && w) continue;
        const chosen = ws.slice(usedWild, usedWild + w);
        fill(i + 1, [...used, ...pool.slice(0, n), ...chosen], usedWild + w, {
          ...subs,
          ...Object.fromEntries(chosen.map((c) => [c.id, rank])),
        });
      }
    }
    fill(0, [], 0, {});
  }
  for (const c of hand) add('single', [c], power(c.rank, level));
  for (let r = 2; r <= 16; r++) {
    pattern('pair', [[r, 2]], power(r, level));
    if (r <= 14) {
      pattern('triple', [[r, 3]], power(r, level));
      for (let n = 4; n <= 10; n++) pattern('bomb', [[r, n]], power(r, level));
      for (let p = 2; p <= 16; p++)
        if (p !== r)
          pattern(
            'fullhouse',
            [
              [r, 3],
              [p, 2],
            ],
            power(r, level),
          );
    }
  }
  for (const [kind, width, count] of [
    ['straight', 5, 1],
    ['pairs', 3, 2],
    ['plate', 2, 3],
  ] as [Kind, number, number][]) {
    // A may be low or high; sequences use printed rank, never elevated level strength.
    for (let start = 1; start <= 15 - width; start++) {
      const ranks = Array.from({ length: width }, (_, i) => (start + i === 1 ? 14 : start + i));
      pattern(
        kind,
        ranks.map((r) => [r, count]),
        start + width - 1,
      );
      if (kind === 'straight')
        for (const suit of ['S', 'H', 'C', 'D'] as const)
          pattern(
            'flush',
            ranks.map((r) => [r, 1]),
            start + width - 1,
            suit,
          );
    }
  }
  const kings = hand.filter((c) => c.suit === 'J');
  if (kings.length === 4) add('kings', kings, 100);
  if (last) out.set('pass', { id: 'pass', kind: 'pass', cards: [], strength: 0, label: '不出' });
  return [...out.values()].sort(
    (a, b) =>
      a.cards.length - b.cards.length || a.strength - b.strength || a.id.localeCompare(b.id),
  );
}
export function newGame(): Game {
  return {
    id: randomUUID(),
    round: 1,
    level: 2,
    levels: [2, 2],
    hands: deal(),
    turn: 0,
    last: null,
    lastSeat: -1,
    passed: [],
    finished: [],
    previous: [],
    status: 'ready',
    winner: null,
    history: [],
    revision: 0,
    tribute: [],
  };
}
function nextActive(g: Game, seat: number): number {
  for (let i = 1; i <= 4; i++) {
    const n = (seat + i) % 4;
    if (!g.finished.includes(n)) return n;
  }
  return seat;
}
export function applyMove(g: Game, id: string): Move {
  if (g.status === 'round-over' || g.status === 'match-over') throw Error('本局已结束');
  const move = legalMoves(g.hands[g.turn], g.level, g.last).find((m) => m.id === id);
  if (!move) throw Error('非法动作');
  const seat = g.turn;
  if (move.kind === 'pass') g.passed.push(seat);
  else {
    const ids = new Set(move.cards.map((c) => c.id));
    g.hands[seat] = g.hands[seat].filter((c) => !ids.has(c.id));
    g.last = move;
    g.lastSeat = seat;
    g.passed = [];
    if (!g.hands[seat].length) g.finished.push(seat);
  }
  const doubleWin = g.finished.length === 2 && g.finished[0] % 2 === g.finished[1] % 2;
  if (doubleWin || g.finished.length === 3) {
    for (let offset = 1; offset <= 4; offset++) {
      const remaining = (seat + offset) % 4;
      if (!g.finished.includes(remaining)) g.finished.push(remaining);
    }
    const team = g.finished[0] % 2;
    const partnerRank = g.finished.indexOf((g.finished[0] + 2) % 4);
    g.winner = team;
    if (g.level === 14 && g.levels[team] === 14 && partnerRank <= 2) {
      g.status = 'match-over';
    } else {
      g.levels[team] = Math.min(
        14,
        g.levels[team] + (partnerRank === 1 ? 3 : partnerRank === 2 ? 2 : 1),
      );
      g.status = 'round-over';
    }
    g.revision++;
    return move;
  }
  const challengers = [0, 1, 2, 3].filter((s) => s !== g.lastSeat && !g.finished.includes(s));
  if (g.last && challengers.every((s) => g.passed.includes(s))) {
    let lead = g.lastSeat;
    if (g.finished.includes(lead)) {
      const partner = (lead + 2) % 4;
      lead = g.finished.includes(partner) ? nextActive(g, lead) : partner;
    }
    g.turn = lead;
    g.last = null;
    g.lastSeat = -1;
    g.passed = [];
  } else g.turn = nextActive(g, seat);
  g.revision++;
  return move;
}
export function nextRound(g: Game, hands: Card[][] = deal()): void {
  if (g.status !== 'round-over') throw Error('仅能在本局结束后进入下一局');
  const order = [...g.finished];
  const team = order[0] % 2;
  g.round++;
  g.level = g.levels[team];
  g.previous = order;
  g.hands = hands;
  g.finished = [];
  g.passed = [];
  g.last = null;
  g.lastSeat = -1;
  g.winner = null;
  g.status = 'paused';
  g.tribute = [];
  g.turn = order[0];
  const double = order[2] % 2 === order[3] % 2;
  const donors = double ? order.slice(2) : [order[3]];
  const bigKings = donors.flatMap((s) => g.hands[s]).filter((c) => c.rank === 16).length;
  if (bigKings === 2) {
    g.tribute.push('抗贡：输方持有两张大王');
    g.turn = order[0];
  } else {
    const offered = donors
      .map((seat) => ({
        seat,
        card: [...g.hands[seat]]
          .filter((c) => !wild(c, g.level))
          .sort(
            (a, b) => power(b.rank, g.level) - power(a.rank, g.level) || a.id.localeCompare(b.id),
          )[0],
      }))
      .sort((a, b) => power(b.card.rank, g.level) - power(a.card.rank, g.level));
    // Equal double tribute: recipients follow the clockwise donor after the first finisher.
    if (double && power(offered[0].card.rank, g.level) === power(offered[1].card.rank, g.level)) {
      offered.sort((a, b) => ((a.seat - order[0] + 4) % 4) - ((b.seat - order[0] + 4) % 4));
      g.turn = (order[0] + 1) % 4;
    } else g.turn = offered[0].seat;
    const swaps = offered.map((offer, i) => {
      const receiver = order[i];
      const candidates = g.hands[receiver]
        .filter((c) => !wild(c, g.level) && c.rank <= 10)
        .sort(
          (a, b) => power(a.rank, g.level) - power(b.rank, g.level) || a.id.localeCompare(b.id),
        );
      const returned =
        candidates[0] ??
        [...g.hands[receiver]]
          .filter((c) => !wild(c, g.level))
          .sort((a, b) => power(a.rank, g.level) - power(b.rank, g.level))[0];
      return { ...offer, receiver, returned };
    });
    for (const s of swaps) {
      g.hands[s.seat] = g.hands[s.seat].filter((c) => c.id !== s.card.id);
      g.hands[s.receiver] = g.hands[s.receiver].filter((c) => c.id !== s.returned.id);
      g.hands[s.seat].push(s.returned);
      g.hands[s.receiver].push(s.card);
      g.tribute.push(
        `${s.seat + 1}号 → ${s.receiver + 1}号：贡 ${cardName(s.card)}，还 ${cardName(s.returned)}`,
      );
    }
  }
  g.revision++;
  g.history.push({
    seq: g.history.length + 1,
    seat: -1,
    text: `第 ${g.round} 局，打 ${rankName(g.level)}。${g.tribute.join('；')}`,
    source: '裁判',
    elapsedMs: 0,
    time: new Date().toISOString(),
  });
}
