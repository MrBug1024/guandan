import type { AgentConfig, DecisionTrace, Entry, Game, Move } from './types';

export interface AgentRoundMetrics {
  seat: number;
  name: string;
  provider: AgentConfig['provider'];
  model: string;
  decisions: number;
  fallbacks: number;
  averageLatencyMs: number;
  medianLatencyMs: number;
  actionCounts: Record<string, number>;
}

export interface PartnerLeadEvent {
  seq: number;
  seat: number;
  partnerSeat: number;
  action: 'pass' | 'play-over-partner';
  opportunity: 'available' | 'forced' | 'unknown';
  moveLabel: string;
}

export interface RoundAnalytics {
  decisionCount: number;
  successfulModelDecisions: number;
  externalModelRequests: number;
  forcedMoves: number;
  fallbacks: number;
  fallbackRate: number;
  averageLatencyMs: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
  actionCounts: Record<string, number>;
  sourceCounts: Record<string, number>;
  partnerLeadEvents: PartnerLeadEvent[];
  agents: AgentRoundMetrics[];
  latencyTimeline: Array<{ seq: number; seat: number; elapsedMs: number }>;
}

type FrameState = Pick<Game, 'last' | 'lastSeat'>;
type AnalyticsEntry = Omit<
  Pick<Entry, 'seq' | 'seat' | 'move' | 'source' | 'elapsedMs' | 'error' | 'after' | 'decision'>,
  'decision'
> & { decision?: Pick<DecisionTrace, 'method' | 'providerRequestCount' | 'legalActionCount'> };
type RoundState = { history: AnalyticsEntry[]; last: Move | null; lastSeat: number; round: number };

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]!;
}

export function analyzeRound(
  initial: FrameState,
  game: RoundState,
  agents: AgentConfig[],
): RoundAnalytics {
  const entries = game.history.filter(
    (entry) => !entry.after || entry.after.round === game.round,
  );
  const decisions = entries.filter(
    (entry): entry is AnalyticsEntry & { move: NonNullable<Entry['move']> } =>
      entry.seat >= 0 && !!entry.move,
  );
  const latencies = decisions.map((entry) => Math.max(0, entry.elapsedMs));
  const actionCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  const partnerLeadEvents: PartnerLeadEvent[] = [];
  const latencyTimeline = decisions.map((entry) => ({
    seq: entry.seq,
    seat: entry.seat,
    elapsedMs: Math.max(0, entry.elapsedMs),
  }));
  const perAgent = agents.map((agent, seat) => ({
    seat,
    name: agent.name,
    provider: agent.provider,
    model: agent.provider === 'builtin' ? '内置策略' : agent.model,
    decisions: 0,
    fallbacks: 0,
    latencies: [] as number[],
    actionCounts: {} as Record<string, number>,
  }));
  let prior: FrameState = { last: initial.last, lastSeat: initial.lastSeat };
  let fallbacks = 0;
  let forcedMoves = 0;
  let successfulModelDecisions = 0;
  let externalModelRequests = 0;

  for (const entry of entries) {
    if (entry.seat >= 0 && entry.move) {
      const agent = perAgent[entry.seat];
      if (agent) {
        agent.decisions++;
        agent.latencies.push(Math.max(0, entry.elapsedMs));
        agent.actionCounts[entry.move.kind] = (agent.actionCounts[entry.move.kind] ?? 0) + 1;
        if (entry.error) agent.fallbacks++;
      }
      actionCounts[entry.move.kind] = (actionCounts[entry.move.kind] ?? 0) + 1;
      sourceCounts[entry.source] = (sourceCounts[entry.source] ?? 0) + 1;
      if (entry.error) fallbacks++;
      if (entry.source === '裁判强制动作') forcedMoves++;
      if (entry.decision?.method === 'model') successfulModelDecisions++;
      externalModelRequests += entry.decision?.providerRequestCount ?? 0;

      if (prior.last && prior.lastSeat >= 0 && prior.lastSeat % 2 === entry.seat % 2) {
        const legalActionCount = entry.decision?.legalActionCount;
        const opportunity = entry.move.kind !== 'pass'
          ? 'available'
          : entry.decision?.method === 'forced' || legalActionCount === 1
            ? 'forced'
            : legalActionCount !== undefined && legalActionCount > 1
              ? 'available'
              : 'unknown';
        partnerLeadEvents.push({
          seq: entry.seq,
          seat: entry.seat,
          partnerSeat: prior.lastSeat,
          action: entry.move.kind === 'pass' ? 'pass' : 'play-over-partner',
          opportunity,
          moveLabel: entry.move.label,
        });
      }
    }
    if (entry.after) prior = { last: entry.after.last, lastSeat: entry.after.lastSeat };
  }

  const average = (values: number[]) =>
    values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
  return {
    decisionCount: decisions.length,
    successfulModelDecisions,
    externalModelRequests,
    forcedMoves,
    fallbacks,
    fallbackRate: decisions.length ? fallbacks / decisions.length : 0,
    averageLatencyMs: average(latencies),
    medianLatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    actionCounts,
    sourceCounts,
    partnerLeadEvents,
    agents: perAgent.map(({ latencies: times, ...agent }) => ({
      ...agent,
      averageLatencyMs: average(times),
      medianLatencyMs: percentile(times, 0.5),
    })),
    latencyTimeline,
  };
}
