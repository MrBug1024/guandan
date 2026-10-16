import { ref } from 'vue';
import type { Game, AgentConfig, StudyProtocol } from '../shared/types';
export const replaySession = ref<{
  game: Game;
  initial: Game;
  agents: AgentConfig[];
  study?: StudyProtocol;
}>();
