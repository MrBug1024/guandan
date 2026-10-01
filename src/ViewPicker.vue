<script setup lang="ts">
import type { AgentConfig } from '../shared/types';
defineProps<{ agents: AgentConfig[]; value: string; disabled?: boolean }>();
const emit = defineEmits<{ change: [value: string] }>();
</script>
<template>
  <label class="view-picker">
    <span>观看视角</span>
    <select
      :value="value"
      :disabled="disabled"
      @change="emit('change', ($event.target as HTMLSelectElement).value)"
    >
      <option value="third">第三视角 · 全桌观战</option>
      <option v-for="(agent, seat) in agents" :key="seat" :value="String(seat)">
        {{ agent.name }} · 第一视角
      </option>
    </select>
  </label>
</template>
