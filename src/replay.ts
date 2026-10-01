import { ref } from 'vue';
import type { Game, AgentConfig } from '../shared/types';
export const replaySession = ref<{ game: Game; initial: Game; agents: AgentConfig[] }>();
