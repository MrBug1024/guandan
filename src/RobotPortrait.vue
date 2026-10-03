<script setup lang="ts">
import { useId } from 'vue';
defineProps<{ seat: number }>();
const colors = ['#e68fa9', '#84a1e1', '#82bda1', '#edb56e'];
const portraitId = useId();
</script>
<template>
  <svg class="robot-portrait" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <defs>
      <radialGradient :id="`${portraitId}-body`" cx=".35" cy=".2" r=".85">
        <stop stop-color="#fff5e7" stop-opacity=".7" />
        <stop offset=".5" :stop-color="colors[seat]" />
        <stop offset="1" :stop-color="colors[seat]" stop-opacity=".7" />
      </radialGradient>
      <linearGradient :id="`${portraitId}-cream`" x2="0" y2="1">
        <stop stop-color="#fff8ec" />
        <stop offset="1" stop-color="#edcfb4" />
      </linearGradient>
    </defs>
    <path d="M32 8v9" stroke="#dfbd80" stroke-width="2.5" />
    <circle cx="32" cy="6" r="3" fill="#dfbd80" />
    <g :fill="`url(#${portraitId}-body)`" stroke="#ffffff35" stroke-width="1">
      <template v-if="seat === 1">
        <ellipse cx="18" cy="16" rx="6" ry="14" transform="rotate(-12 18 16)" />
        <ellipse cx="46" cy="16" rx="6" ry="14" transform="rotate(12 46 16)" />
      </template>
      <template v-else-if="seat === 0">
        <path d="M10 28 13 10l17 12M54 28 51 10 34 22" />
      </template>
      <template v-else>
        <circle cx="15" cy="21" r="9" />
        <circle cx="49" cy="21" r="9" />
      </template>
      <ellipse cx="32" cy="36" rx="25" ry="22" />
    </g>
    <g fill="#f1c2cb" opacity=".8">
      <template v-if="seat === 1">
        <ellipse cx="18" cy="15" rx="2.5" ry="9" transform="rotate(-12 18 15)" />
        <ellipse cx="46" cy="15" rx="2.5" ry="9" transform="rotate(12 46 15)" />
      </template>
      <template v-else-if="seat === 0">
        <path d="m14 23 2-8 8 8M50 23l-2-8-8 8" />
      </template>
      <template v-else>
        <circle cx="15" cy="21" r="4" />
        <circle cx="49" cy="21" r="4" />
      </template>
    </g>
    <ellipse cx="32" cy="45" rx="13" ry="8.5" :fill="`url(#${portraitId}-cream)`" />
    <path
      d="M19 27q3-2 6 0m14 0q3-2 6 0"
      stroke="#304452"
      stroke-opacity=".4"
      stroke-width="1"
      stroke-linecap="round"
    />
    <ellipse cx="22" cy="35" rx="3.5" ry="4.9" fill="#182832" />
    <ellipse cx="42" cy="35" rx="3.5" ry="4.9" fill="#182832" />
    <ellipse cx="21" cy="33.5" rx="1.2" ry="1.5" fill="white" />
    <ellipse cx="41" cy="33.5" rx="1.2" ry="1.5" fill="white" />
    <circle cx="23" cy="37" r=".6" fill="#b4dce6" />
    <circle cx="43" cy="37" r=".6" fill="#b4dce6" />
    <ellipse cx="32" cy="43" rx="2.5" ry="1.8" fill="#704956" />
    <path d="M28 47q4 4 8 0" stroke="#704956" stroke-width="1.5" stroke-linecap="round" />
    <ellipse cx="15" cy="42" rx="3.5" ry="1.7" fill="#d7849d" opacity=".65" />
    <ellipse cx="49" cy="42" rx="3.5" ry="1.7" fill="#d7849d" opacity=".65" />
  </svg>
</template>
