import type { AgentConfig, Game, PublicGame } from '../shared/types.js';
export function safeAgent(agent: AgentConfig): AgentConfig {
  const { apiKey, deleteKey, ...safe } = agent;
  const jev = agent.jev;
  return {
    ...safe,
    keyConfigured: Boolean(apiKey || process.env[agent.keyEnv]),
    ...(jev
      ? {
          jev: {
            enabled: jev.enabled,
            baseUrl: jev.baseUrl,
            keyEnv: jev.keyEnv,
            keyConfigured: Boolean(jev.apiKey || process.env[jev.keyEnv]),
          },
        }
      : {}),
  };
}

/** The spectator follows seat 0. The three other hands never enter this payload. */
export function publicState(
  game: Game,
  agents: AgentConfig[],
  options: {
    viewpointSeat?: number;
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
    agents: agents.map(safeAgent),
    ...options,
    viewpointSeat: options.viewpointSeat ?? 0,
    visibleHand: hands[options.viewpointSeat ?? 0],
  };
}
