<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });
const paths: Record<string, string> = {
  home: 'M3 10 12 3l9 7M5 9v12h14V9M9 21v-7h6v7',
  models: 'M5 3h14v18H5zM8 7h8M8 12h8M8 17h5',
  live: 'M3 5h18v12H3zM8 21h8M12 17v4M10 8l5 3-5 3z',
  replay: 'M6 3h12v18H6zM9 7h6M9 11h6M9 15h4',
  exit: 'M9 3H4v18h5M13 7l5 5-5 5M8 12h10',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
};
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] ?? paths.settings" />
  </svg>
</template>
