<script setup lang="ts">
import { computed } from 'vue';
import type { PublicGame } from '../shared/types';
import RobotPortrait from './RobotPortrait.vue';
import './arena-roster.css';

const props = defineProps<{
  game: PublicGame;
  cameraMode: 'first' | 'third';
  reducedMotion: boolean;
}>();
const colors = ['#f2adbd', '#aabef6', '#add8bc', '#f3ce93'];
const teams = [
  [0, 2],
  [1, 3],
];
function seatPosition(seat: number) {
  const relative = props.cameraMode === 'third' ? seat : (seat - props.game.viewpointSeat + 4) % 4;
  return [props.cameraMode === 'first' ? '我们' : '近侧', '左侧', '对侧', '右侧'][relative];
}
function finishName(seat: number) {
  const index = props.game.finished.indexOf(seat);
  if (index < 0) return '';
  return props.game.finished.length === 4 &&
    props.game.finished[0]! % 2 === props.game.finished[1]! % 2 &&
    props.game.counts[seat]! > 0
    ? '双下'
    : ['头游', '二游', '三游', '末游'][index];
}
function activity(seat: number) {
  if (finishName(seat)) return '已出完';
  if (props.game.status === 'paused') return '已暂停';
  if (props.game.status === 'ready') return '等待开局';
  if (props.game.thinking === seat) return '思考中';
  if (props.game.turn === seat) return '轮到出牌';
  return '等待出牌';
}
const activeSeat = computed(() => props.game.thinking ?? props.game.turn);
</script>
<template>
  <aside
    class="arena-roster"
    :class="{ 'motion-reduced': reducedMotion }"
    aria-label="对局选手状态"
  >
    <section
      v-for="(seats, team) in teams"
      :key="team"
      class="roster-team"
      :class="'roster-team-' + team"
    >
      <header>
        <span>队伍{{ team === 0 ? '一' : '二' }}</span
        ><small>对家搭档</small><i aria-hidden="true"></i>
      </header>
      <div
        v-for="seat in seats"
        :key="seat"
        class="roster-player"
        :class="{
          'roster-active': activeSeat === seat && game.status === 'running',
          'roster-finished': game.finished.includes(seat),
          'roster-observed': seat === game.viewpointSeat,
        }"
        :style="{ '--seat-color': colors[seat] }"
      >
        <div class="roster-avatar"><RobotPortrait :seat="seat" /></div>
        <div class="roster-identity">
          <div class="roster-name">
            <strong :title="game.agents[seat]!.name">{{ game.agents[seat]!.name }}</strong
            ><small>{{ seatPosition(seat) }}</small>
          </div>
          <div class="roster-activity" :class="{ 'is-thinking': game.thinking === seat }">
            <i v-if="game.thinking === seat" class="roster-thinking" aria-hidden="true"></i>
            <i
              v-else-if="activeSeat === seat && game.status === 'running'"
              class="roster-turn"
              aria-hidden="true"
            ></i>
            <span>{{ activity(seat) }}</span>
          </div>
        </div>
        <div
          class="roster-count"
          :class="{ 'roster-low': game.counts[seat]! > 0 && game.counts[seat]! <= 3 }"
        >
          <template v-if="finishName(seat)"
            ><b class="roster-place">{{ finishName(seat) }}</b
            ><small>完赛</small></template
          >
          <template v-else
            ><b>{{ game.counts[seat] }}</b
            ><small>剩余牌</small></template
          >
        </div>
        <div class="roster-progress" aria-hidden="true">
          <i :style="{ transform: `scaleX(${game.counts[seat]! / 27})` }"></i>
        </div>
      </div>
    </section>
  </aside>
</template>
