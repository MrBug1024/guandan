import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRound } from '../shared/analytics.js';
import { defaults } from '../server/agents.js';
import { newGame } from '../server/rules.js';
import type { DecisionTrace, Entry, Game, Move } from '../shared/types.js';
import { gameFrame } from '../shared/types.js';

function makeEntry(game: Game, seat: number, move: Move, last: Move | null, lastSeat: number, source: string, error?: string, decision?: DecisionTrace): Entry {
  const after = gameFrame(game);
  after.last = move.kind === 'pass' ? last : move;
  after.lastSeat = move.kind === 'pass' ? lastSeat : seat;
  return {
    seq: game.history.length + 1,
    seat,
    text: move.label,
    move,
    source,
    elapsedMs: 1000 * (seat + 1),
    time: new Date().toISOString(),
    ...(error ? { error } : {}),
    ...(decision ? { decision } : {}),
    after,
  };
}

function move(kind: Move['kind'], label: string = kind): Move {
  return { id: label, kind, cards: [], strength: 1, label };
}

function externalAgents() {
  return defaults.map((agent, seat) => ({
    ...structuredClone(agent),
    provider: 'openai' as const,
    model: `model-${seat}`,
  }));
}

test('round analytics excludes referee events and keeps fallback, latency and action counts explicit', () => {
  const game = newGame();
  const initial = structuredClone(game);
  game.history = [];
  const lead = makeEntry(game, 0, move('single'), null, 0, 'model-0', undefined, {
    method: 'model', candidateSource: 'model-shortlist', providerRequestCount: 2,
    candidateCount: 3, selectedMoveId: 'single', rationale: '选择单张',
  });
  game.history.push(lead);
  const forced = makeEntry(game, 1, move('pass'), lead.move!, 0, '裁判强制动作', undefined, {
    method: 'forced', candidateSource: 'forced', providerRequestCount: 0,
    candidateCount: 1, selectedMoveId: 'pass', rationale: '仅有一个合法动作',
  });
  game.history.push(forced);
  game.history.push(
    makeEntry(game, 2, move('bomb'), lead.move!, 0, '本地兜底', 'model request failed', {
      method: 'fallback', candidateSource: 'unavailable', providerRequestCount: 1,
      candidateCount: 4, selectedMoveId: 'bomb', rationale: '请求失败后兜底',
    }),
  );
  const result = analyzeRound(initial, game, externalAgents());
  assert.equal(result.decisionCount, 3);
  assert.equal(result.successfulModelDecisions, 1);
  assert.equal(result.externalModelRequests, 3);
  assert.equal(result.forcedMoves, 1);
  assert.equal(result.fallbacks, 1);
  assert.equal(result.fallbackRate, 1 / 3);
  assert.equal(result.averageLatencyMs, 2000);
  assert.equal(result.medianLatencyMs, 2000);
  assert.equal(result.p95LatencyMs, 3000);
  assert.deepEqual(result.actionCounts, { single: 1, pass: 1, bomb: 1 });
  assert.equal(result.agents[2]!.fallbacks, 1);
});

test('partner lead responses are recorded as observations, not interpreted as quality scores', () => {
  const game = newGame();
  const initial = structuredClone(game);
  const lead = move('single', 'single 9');
  const overcall = move('pair', 'pair 10');
  initial.last = lead;
  initial.lastSeat = 0;
  const passed = makeEntry(game, 2, move('pass'), lead, 0, 'model-2', undefined, {
    method: 'forced', candidateSource: 'forced', candidateCount: 1, legalActionCount: 1,
    selectedMoveId: 'pass', rationale: '没有可压动作',
  });
  const played = makeEntry(game, 2, overcall, lead, 0, 'model-2', undefined, {
    method: 'model', candidateSource: 'model-shortlist', candidateCount: 2, legalActionCount: 4,
    selectedMoveId: overcall.id, rationale: '接管牌权',
  });
  game.history = [passed, played];
  const result = analyzeRound(initial, game, externalAgents());
  assert.deepEqual(
    result.partnerLeadEvents.map(({ seat, action, opportunity }) => [seat, action, opportunity]),
    [
      [2, 'pass', 'forced'],
      [2, 'play-over-partner', 'available'],
    ],
  );
});

test('legacy forced passes remain unknown instead of being counted as voluntary choices', () => {
  const game = newGame();
  const initial = structuredClone(game);
  const lead = move('single', 'single 9');
  initial.last = lead;
  initial.lastSeat = 0;
  game.history = [makeEntry(game, 2, move('pass'), lead, 0, '旧归档')];
  const result = analyzeRound(initial, game, externalAgents());
  assert.equal(result.partnerLeadEvents[0]?.opportunity, 'unknown');
});
