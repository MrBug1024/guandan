import { rankName, type Card, type PublicGame } from '../shared/types';
import { ROUND_CELEBRATION_MS, CHAMPION_CELEBRATION_MS } from '../shared/broadcast-timing';

export type ArenaMood = 'celebrate' | 'clap' | 'shocked' | 'sad' | 'bow' | 'proud' | 'worried';
export interface ArenaCue {
  id: string;
  kind: 'play' | 'finish' | 'alarm' | 'wind' | 'tribute' | 'settlement' | 'deal';
  tone: 'gold' | 'violet' | 'cyan' | 'rose';
  intensity: 'epic' | 'major' | 'light';
  title: string;
  subtitle: string;
  eyebrow: string;
  seat: number;
  cards: Card[];
  duration: number;
}
export interface ArenaSnapshot {
  id: string;
  round: number;
  seq: number;
  status: PublicGame['status'];
  counts: number[];
  finished: number[];
  windAt?: number;
}
export function arenaSnapshot(game: PublicGame): ArenaSnapshot {
  return {
    id: game.id,
    round: game.round,
    seq: game.history.at(-1)?.seq ?? -1,
    status: game.status,
    counts: [...game.counts],
    finished: [...game.finished],
    windAt: game.wind?.at,
  };
}
const powerful = new Set(['bomb', 'flush', 'kings']);
export const isRoundOver = (game: PublicGame) =>
  game.status === 'round-over' || game.status === 'match-over';

// Select one current public event. Repeated SSE snapshots and old replay frames
// never replay a burst; settlement and tribute take precedence over the final play.
export function selectArenaCue(
  game: PublicGame,
  previous?: ArenaSnapshot,
  now = Date.now(),
): ArenaCue | undefined {
  const sameRound = previous?.id === game.id && previous.round === game.round;
  const entry = game.history.at(-1);
  const base = {
    id: `${game.id}:${game.round}:${entry?.seq ?? -1}:${game.status}`,
    seat: entry && entry.seat >= 0 ? entry.seat : game.turn,
    cards: [] as Card[],
    tone: 'gold' as const,
    intensity: 'major' as const,
    duration: 2600,
  };
  if (isRoundOver(game)) {
    if (sameRound && previous && ['round-over', 'match-over'].includes(previous.status)) return;
    const settlement = game.settlement;
    return {
      ...base,
      kind: 'settlement',
      seat: game.finished[0] ?? game.winner ?? 0,
      title: settlement?.passedA
        ? '巅峰夺冠'
        : settlement?.partnerPlace === 2
          ? '双下！完美配合'
          : '胜利时刻',
      eyebrow: settlement?.passedA ? 'MATCH CHAMPIONS' : 'ROUND VICTORY',
      subtitle: settlement?.upgrade
        ? `连升 ${settlement.upgrade} 级 · ${rankName(settlement.from)} → ${rankName(settlement.to)}`
        : settlement?.passedA
          ? '成功过 A · 本场冠军诞生'
          : '本局获胜 · 结算已确认',
      intensity: 'epic',
      duration: game.status === 'match-over' ? CHAMPION_CELEBRATION_MS : ROUND_CELEBRATION_MS,
    };
  }
  if (!sameRound) {
    if (game.tributeKind && game.tributeUntil && game.tributeUntil > now) {
      return {
        ...base,
        kind: 'tribute',
        title:
          game.tributeKind === 'anti'
            ? '双王护体 · 抗贡成功'
            : game.tributeKind === 'double'
              ? '双贡礼遇'
              : '贡牌时刻',
        subtitle: game.tributeKind === 'anti' ? '两张大王，免进贡、免还贡' : '进贡 · 接贡 · 还贡',
        eyebrow: game.tributeKind === 'anti' ? 'TRIBUTE DEFENDED' : 'TRIBUTE CEREMONY',
        tone: game.tributeKind === 'anti' ? 'cyan' : 'gold',
        duration: Math.min(4000, game.tributeUntil - now),
      };
    }
    // Joining an ongoing broadcast restores the table without celebrating old moves.
    if (!previous || previous.id !== game.id) return;
    return {
      ...base,
      kind: 'deal',
      title: '新局开场',
      subtitle: `第 ${game.round} 局 · 打 ${rankName(game.level)}`,
      eyebrow: 'NEXT ROUND',
      duration: 1800,
      intensity: 'light',
    };
  }
  if (!previous || (entry?.seq ?? -1) <= previous.seq) return;
  if (game.wind && game.wind.at !== previous.windAt) {
    return {
      ...base,
      kind: 'wind',
      seat: game.wind.seat,
      title: '默契接风',
      subtitle: `${game.agents[game.wind.from].name}已出完 · ${game.agents[game.wind.seat].name}接风领出`,
      eyebrow: 'TEAM PLAY',
      tone: 'cyan',
      intensity: 'light',
      duration: 2200,
    };
  }
  if (
    !entry?.move ||
    entry.seat < 0 ||
    entry.after?.round !== game.round ||
    entry.move.kind === 'pass'
  )
    return;
  const move = entry.move;
  const player = game.agents[entry.seat].name;
  const priorPlay = game.history
    .slice(0, -1)
    .filter((e) => e.after?.round === game.round && e.move && e.move.kind !== 'pass')
    .at(-1);
  const counter =
    powerful.has(move.kind) &&
    priorPlay?.move &&
    powerful.has(priorPlay.move.kind) &&
    entry.seat % 2 !== priorPlay.seat % 2;
  const play = {
    ...base,
    kind: 'play' as const,
    cards: move.cards,
    subtitle: `${player} · ${move.label}`,
    eyebrow: counter ? 'POWER COUNTER' : 'HIGHLIGHT PLAY',
  };
  if (move.kind === 'kings')
    return { ...play, title: '四王天炸', tone: 'violet', intensity: 'epic', duration: 3200 };
  if (move.kind === 'flush')
    return {
      ...play,
      title: counter ? '同花顺 · 强势反压' : '同花顺！',
      tone: 'cyan',
      intensity: 'epic',
      duration: 3000,
    };
  if (move.kind === 'bomb')
    return {
      ...play,
      title: counter
        ? '炸弹反压！'
        : move.cards.length >= 6
          ? `${move.cards.length} 张超级炸弹`
          : `${move.cards.length} 张炸弹！`,
      tone: 'gold',
      intensity: move.cards.length >= 6 || counter ? 'epic' : 'major',
      duration: 2800,
    };
  if (game.counts[entry.seat] === 0 && !previous.finished.includes(entry.seat)) {
    return {
      ...base,
      kind: 'finish',
      title: game.finished[0] === entry.seat ? '头游诞生！' : '漂亮收官',
      subtitle: `${player}已出完全部手牌`,
      eyebrow: 'FINISH LINE',
      duration: 2600,
    };
  }
  if (
    game.counts[entry.seat] > 0 &&
    game.counts[entry.seat] <= 3 &&
    previous.counts[entry.seat]! > 3
  ) {
    return {
      ...base,
      kind: 'alarm',
      title: '冲刺时刻',
      subtitle: `${player}只剩 ${game.counts[entry.seat]} 张牌`,
      eyebrow: 'FINAL CARDS',
      tone: 'rose',
      intensity: 'light',
      duration: 2000,
    };
  }
  if (['straight', 'pairs', 'plate'].includes(move.kind)) {
    return {
      ...play,
      title: { straight: '顺子连击', pairs: '连对出击', plate: '钢板压阵' }[
        move.kind as 'straight' | 'pairs' | 'plate'
      ],
      tone: 'cyan',
      intensity: 'light',
      duration: 1800,
    };
  }
  if (move.cards.some((c) => c.rank >= 15) && ['single', 'pair'].includes(move.kind)) {
    return {
      ...play,
      title: move.kind === 'pair' ? '双王出击' : '王牌登场',
      tone: 'violet',
      intensity: 'light',
      duration: 1800,
    };
  }
}

export function actorMood(
  game: PublicGame,
  cue: ArenaCue | undefined,
  seat: number,
): ArenaMood | undefined {
  if (isRoundOver(game)) return seat % 2 === game.winner ? 'celebrate' : 'sad';
  if (!cue) return;
  if (cue.kind === 'tribute') {
    if (game.tributeKind === 'anti') {
      if (game.previous.length !== 4) return;
      const double = game.previous[2]! % 2 === game.previous[3]! % 2;
      const donors = double ? game.previous.slice(2) : game.previous.slice(-1);
      return donors.some((donor) => seat % 2 === donor % 2) ? 'proud' : 'shocked';
    }
    if (game.tributeSteps?.some((s) => s.donor === seat)) return 'bow';
    if (game.tributeSteps?.some((s) => s.receiver === seat)) return 'proud';
    return;
  }
  if (cue.kind === 'deal') return;
  if (cue.kind === 'alarm')
    return seat === cue.seat ? 'proud' : seat % 2 !== cue.seat % 2 ? 'worried' : 'clap';
  if (seat === cue.seat) return cue.kind === 'wind' ? 'proud' : 'celebrate';
  if (seat % 2 === cue.seat % 2) return 'clap';
  return cue.intensity === 'light' ? undefined : 'shocked';
}
