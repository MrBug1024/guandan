import { tableCall } from '../shared/voice-lines';
import type { DecisionTrace, PublicEntry } from '../shared/types';

export type ActionCursor = { gameId: string; round: number; seq?: number };

export function classifyActionUpdate(
  current: ActionCursor,
  previous?: ActionCursor,
): 'reset' | 'unchanged' | 'advance' {
  if (!previous || current.gameId !== previous.gameId || current.round !== previous.round)
    return 'reset';
  if (current.seq === previous.seq) return 'unchanged';
  if (current.seq === undefined || (previous.seq !== undefined && current.seq < previous.seq))
    return 'reset';
  return 'advance';
}

export type DecisionInsight = {
  seq: number;
  seat: number;
  slot: 'bottom' | 'left' | 'top' | 'right';
  name: string;
  partner: boolean;
  action: string;
  moment: 'routine' | 'tactical' | 'critical';
  rationale: string;
  tacticalRead: string;
};

export function makeDecisionInsight(
  entry: PublicEntry,
  trace: DecisionTrace | PublicEntry['decision'] | undefined,
  agentName: string,
  viewpointSeat: number,
): DecisionInsight | null {
  const rationale = trace?.rationale?.trim();
  if (!entry.move || trace?.method !== 'model' || !rationale) return null;

  const legalActionCount = 'legalActionCount' in trace ? trace.legalActionCount : undefined;
  const canChooseToPlay = entry.move.kind === 'pass' && (legalActionCount ?? 0) > 1;

  return {
    seq: entry.seq,
    seat: entry.seat,
    slot: (['bottom', 'left', 'top', 'right'] as const)[
      (entry.seat - viewpointSeat + 4) % 4
    ],
    name: agentName || 'AI',
    partner: entry.seat % 2 === viewpointSeat % 2,
    action: entry.voiceLine ?? tableCall(entry.move, canChooseToPlay),
    moment: trace.moment ?? 'routine',
    rationale,
    tacticalRead: trace.tacticalRead?.trim() ?? '',
  };
}
