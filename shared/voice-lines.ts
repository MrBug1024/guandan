import type { Move } from './types';

const rankName = (rank: number) =>
  ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '小王', 16: '大王' })[rank] ?? String(rank);

export function tableCall(move: Move, canChooseToPlay = false): string {
  if (move.kind === 'pass') return canChooseToPlay ? '不要' : '要不起';
  const ranks = move.cards.map((card) => move.substitutions?.[card.id] ?? card.rank);
  const rank = rankName(ranks[0] ?? 0);
  switch (move.kind) {
    case 'single':
      return `${{ S: '黑桃', H: '红桃', C: '梅花', D: '方块', J: '' }[move.cards[0]!.suit]}${rank}`;
    case 'pair':
      return `对${rank}`;
    case 'triple':
      return `三个${rank}`;
    case 'fullhouse':
      return '三带二';
    case 'straight':
      return '顺子';
    case 'pairs':
      return '连对';
    case 'plate':
      return '钢板';
    case 'bomb':
      return move.cards.length >= 6 ? `${move.cards.length}张炸弹` : '炸弹';
    case 'flush':
      return '同花顺';
    case 'kings':
      return '王炸';
    default:
      return '出牌';
  }
}

export function tableVoiceText(entry: {
  seat: number;
  move?: Move;
  voiceLine?: string;
  after?: { counts: number[]; lastSeat: number; tributeKind?: string; settlement?: unknown };
  decision?: { method: string; tacticalRead?: string };
}): string | undefined {
  if (entry.seat < 0) {
    if (entry.after?.tributeKind === 'anti') return '双王抗贡';
    if (entry.after?.tributeKind) return '进贡开始';
    if (entry.after?.settlement) return '本局结束';
    return undefined;
  }
  if (!entry.move) return undefined;
  const call = entry.voiceLine ?? tableCall(entry.move);
  const partnerLead = entry.after?.lastSeat === (entry.seat + 2) % 4;
  const opponentNearFinish = entry.after?.counts.some(
    (count, seat) => seat % 2 !== entry.seat % 2 && count > 0 && count <= 3,
  );
  const read = entry.decision?.tacticalRead?.trim();
  if (entry.decision?.method === 'model' && read &&
    (opponentNearFinish || (entry.move.kind === 'pass' && partnerLead)))
    return `${call}。${read.slice(0, 72)}`;
  return call;
}
