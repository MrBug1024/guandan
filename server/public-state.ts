import type { AgentConfig, Game, PublicGame } from '../shared/types.js';

/** The spectator follows seat 0. The three other hands never enter this payload. */
export function publicState(
  game: Game,
  agents: AgentConfig[],
  options: {
    thinking: number | null;
    delayMs: number;
    autoNext: boolean;
    nextRoundAt: number | null;
  },
): PublicGame {
  const { hands, ...rest } = game;
  return {
    ...rest,
    counts: hands.map((h) => h.length),
    agents,
    ...options,
    viewpointSeat: 0,
    visibleHand: hands[0],
  };
}
