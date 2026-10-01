export type Suit = 'S' | 'H' | 'C' | 'D' | 'J';
export interface Card {
  id: string;
  rank: number;
  suit: Suit;
}
export type Kind =
  | 'single'
  | 'pair'
  | 'triple'
  | 'fullhouse'
  | 'straight'
  | 'pairs'
  | 'plate'
  | 'bomb'
  | 'flush'
  | 'kings'
  | 'pass';
export interface Move {
  id: string;
  kind: Kind;
  cards: Card[];
  strength: number;
  label: string;
  substitutions?: Record<string, number>;
}
export interface AgentConfig {
  name: string;
  provider: 'builtin' | 'openai';
  jev?: {
    enabled: boolean;
    baseUrl: string;
    keyEnv: string;
    apiKey?: string;
    keyConfigured?: boolean;
    deleteKey?: boolean;
  };
  apiKey?: string;
  keyConfigured?: boolean;
  deleteKey?: boolean;
  baseUrl: string;
  model: string;
  keyEnv: string;
  personality: string;
}
export interface Entry {
  seq: number;
  seat: number;
  text: string;
  move?: Move;
  source: string;
  elapsedMs: number;
  time: string;
  error?: string;
  after?: GameFrame;
}
export interface Game {
  id: string;
  round: number;
  level: number;
  levels: [number, number];
  hands: Card[][];
  turn: number;
  last: Move | null;
  lastSeat: number;
  passed: number[];
  finished: number[];
  previous: number[];
  status: 'ready' | 'running' | 'paused' | 'round-over' | 'match-over';
  winner: number | null;
  history: Entry[];
  revision: number;
  tribute: string[];
  aFailures?: [number, number];
  settlement?: {
    team: number;
    partnerPlace: number;
    upgrade: number;
    from: number;
    to: number;
    passedA: boolean;
    failedA: number;
    demotedTeam?: number;
  };
  tributeSteps?: { donor: number; receiver: number; offered: Card; returned: Card }[];
  tributeKind?: 'single' | 'double' | 'anti';
  tributeUntil?: number;
  wind?: { seat: number; from: number; at: number };
}
export interface PublicGame extends Omit<Game, 'hands'> {
  narration?: { engine: 'browser' | 'api'; ready: boolean };
  presentation?: { speech: boolean; showFeed: boolean };
  counts: number[];
  hands?: Card[][];
  agents: AgentConfig[];
  thinking: number | null;
  delayMs: number;
  autoNext: boolean;
  viewpointSeat: number;
  visibleHand: Card[];
  nextRoundAt: number | null;
}
export type GameFrame = Pick<
  Game,
  | 'turn'
  | 'last'
  | 'lastSeat'
  | 'finished'
  | 'status'
  | 'levels'
  | 'winner'
  | 'level'
  | 'round'
  | 'revision'
  | 'tribute'
> &
  Pick<
    Game,
    'aFailures' | 'settlement' | 'tributeSteps' | 'tributeKind' | 'tributeUntil' | 'wind'
  > & { counts: number[] };
export function gameFrame(g: Game): GameFrame {
  return structuredClone({
    turn: g.turn,
    last: g.last,
    lastSeat: g.lastSeat,
    finished: g.finished,
    status: g.status,
    levels: g.levels,
    winner: g.winner,
    level: g.level,
    round: g.round,
    revision: g.revision,
    tribute: g.tribute,
    aFailures: g.aFailures,
    settlement: g.settlement,
    tributeSteps: g.tributeSteps,
    tributeKind: g.tributeKind,
    tributeUntil: g.tributeUntil,
    wind: g.wind,
    counts: g.hands.map((h) => h.length),
  });
}
export const rankName = (r: number) =>
  ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '小王', 16: '大王' })[r] ?? String(r);
export const cardName = (c: Card) =>
  (c.suit === 'J' ? '' : { S: '♠', H: '♥', C: '♣', D: '♦' }[c.suit]) + rankName(c.rank);
