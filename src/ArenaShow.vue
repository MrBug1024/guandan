<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { cardName, rankName, type Card, type PublicGame } from '../shared/types';
import { actorMood, isRoundOver, type ArenaCue, type ArenaMood } from './arena-events';
import './arena-show.css';
import type { PlayerAnchor } from './arena-projection';

const props = defineProps<{
  game: PublicGame;
  cue?: ArenaCue;
  reducedMotion: boolean;
  anchors: PlayerAnchor[];
  cameraMode: 'first' | 'third';
}>();
const canvas = ref<HTMLCanvasElement>();
const host = ref<HTMLDivElement>();
const width = ref(innerWidth),
  height = ref(innerHeight);
const colors = ['#f2adbd', '#aabef6', '#add8bc', '#f3ce93'];
const moodLabels: Record<ArenaMood, string> = {
  celebrate: '好耶！',
  clap: '漂亮！',
  shocked: '这也太强了！',
  sad: '呜…下局再赢',
  bow: '大牌请收下',
  proud: '看我的！',
  worried: '得抓紧了…',
};
const reactions = computed(() =>
  props.game.agents
    .map((agent, seat) => ({
      seat,
      name: agent.name,
      mood: actorMood(props.game, props.cue, seat),
    }))
    .filter((reaction) => {
      const anchor = props.anchors[reaction.seat];
      if (
        !reaction.mood ||
        !anchor ||
        (props.cameraMode === 'first' && reaction.seat === props.game.viewpointSeat)
      )
        return false;
      // Four speech bubbles cannot fit above the phone's compact award stage.
      // Keep the winners' cheers readable; the losers' poses and result rows remain visible.
      if (
        (width.value <= 900 || height.value <= 540) &&
        isRoundOver(props.game) &&
        reaction.seat % 2 !== props.game.winner
      )
        return false;
      // The card closeup owns the centre; side reactions and the 3D poses tell the story.
      return (
        !props.cue?.cards.length ||
        Math.abs(anchor.x - width.value / 2) > (width.value <= 700 ? 80 : 120)
      );
    }),
);
function reactionStyle(seat: number) {
  const anchor = props.anchors[seat]!;
  const side = props.cameraMode === 'third' ? seat : (seat - props.game.viewpointSeat + 4) % 4;
  return {
    left: `${Math.max(64, Math.min(width.value - 64, anchor.x + (side === 1 ? 24 : side === 3 ? -24 : 0)))}px`,
    top: `${Math.max(width.value <= 700 ? 210 : 140, Math.min(height.value - 190, anchor.bounds.top - 10))}px`,
    '--reaction-color': colors[seat],
  };
}
const suit = (card: Card) =>
  card.suit === 'J' ? '★' : { S: '♠', H: '♥', C: '♣', D: '♦' }[card.suit];
const red = (card: Card) => card.suit === 'H' || card.suit === 'D' || card.rank === 16;
function cardStyle(index: number, length: number) {
  const middle = (length - 1) / 2;
  return {
    '--card-index': index,
    '--card-angle': `${(index - middle) * Math.min(6, 32 / length)}deg`,
    '--card-lift': `${Math.abs(index - middle) * 3}px`,
  };
}
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  age: number;
  color: string;
  size: number;
  confetti: boolean;
  rotation: number;
  gravity: number;
  drag: number;
}
interface Burst {
  at: number;
  x: number;
  y: number;
  done: boolean;
  confetti: boolean;
  color: string;
}
let sparks: Spark[] = [],
  bursts: Burst[] = [],
  frame = 0,
  start = 0,
  lastTime = 0;
let context: CanvasRenderingContext2D | null = null;
const tones = {
  gold: ['#ffe1a0', '#ffb661', '#fff7db'],
  violet: ['#d0b5ff', '#a98aff', '#ffccf1'],
  cyan: ['#9cfff1', '#68c7f5', '#e0fffa'],
  rose: ['#ffb7c8', '#f58eaa', '#ffe1a0'],
};
function stopParticles() {
  cancelAnimationFrame(frame);
  frame = 0;
  sparks = [];
  bursts = [];
  context?.clearRect(0, 0, width.value, height.value);
}
function resize() {
  if (!host.value || !canvas.value) return;
  const bounds = host.value.getBoundingClientRect();
  width.value = bounds.width;
  height.value = bounds.height;
  const ratio = Math.min(devicePixelRatio, 1.5);
  canvas.value.width = Math.round(bounds.width * ratio);
  canvas.value.height = Math.round(bounds.height * ratio);
  context = canvas.value.getContext('2d');
  context?.setTransform(ratio, 0, 0, ratio, 0, 0);
}
function launch() {
  stopParticles();
  const cue = props.cue;
  if (!cue || props.reducedMotion || document.hidden || !context || cue.intensity === 'light')
    return;
  const celebration = ['settlement', 'finish'].includes(cue.kind);
  const settlement = cue.kind === 'settlement';
  const compact = width.value <= 700;
  const count = settlement ? 18 : cue.intensity === 'epic' ? 8 : 4;
  const festive = ['#ffe3a0', '#ffa8ca', '#aabaff', '#a2f1e7', '#ffc08c', '#e2b6ff'];
  const spacing = settlement ? (cue.duration - 2600) / (count - 1) : 235;
  bursts = Array.from({ length: count }, (_, index) => ({
    at: index * spacing + 480,
    x: [0.16, 0.84, 0.32, 0.68, 0.23, 0.77][index % 6]!,
    y: [0.24, 0.29, 0.18, 0.21, 0.34, 0.17][index % 6]!,
    done: false,
    confetti: false,
    color: settlement ? festive[index % festive.length]! : tones[cue.tone][index % 3]!,
  }));
  if (celebration)
    for (let index = 0; index < (settlement ? 5 : 2); index++)
      bursts.push({
        at: 350 + index * (settlement ? 1650 : 650),
        x: index % 2 ? 0.8 : 0.2,
        y: 0.12,
        done: false,
        confetti: true,
        color: festive[index % festive.length]!,
      });
  start = performance.now();
  lastTime = start;
  function draw(time: number) {
    if (!context) return;
    const elapsed = time - start,
      dt = Math.min((time - lastTime) / 1000, 0.04);
    lastTime = time;
    context.clearRect(0, 0, width.value, height.value);
    const particleLimit = compact ? 650 : 1100;
    context.globalCompositeOperation = 'lighter';
    for (const burst of bursts) {
      if (!burst.confetti && !burst.done && elapsed >= burst.at - 480 && elapsed < burst.at) {
        const progress = (elapsed - burst.at + 480) / 480;
        const x = burst.x * width.value;
        const y = (0.68 - (0.68 - burst.y) * (1 - Math.pow(1 - progress, 2))) * height.value;
        const trail = context.createLinearGradient(x, y, x, y + 55);
        trail.addColorStop(0, burst.color);
        trail.addColorStop(1, 'transparent');
        context.strokeStyle = trail;
        context.lineWidth = compact ? 2 : 3;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x, y + 55);
        context.stroke();
        context.fillStyle = '#fff9df';
        context.beginPath();
        context.arc(x, y, compact ? 2 : 3, 0, Math.PI * 2);
        context.fill();
      }
      const age = (elapsed - burst.at) / 1000;
      if (!burst.confetti && burst.done && age < 0.55) {
        context.globalAlpha = (1 - age / 0.55) * 0.5;
        context.strokeStyle = burst.color;
        context.lineWidth = 2;
        context.beginPath();
        context.arc(
          burst.x * width.value,
          burst.y * height.value,
          8 + age * (compact ? 95 : 160),
          0,
          Math.PI * 2,
        );
        context.stroke();
        context.globalAlpha = 1;
      }
      if (burst.done || elapsed < burst.at) continue;
      burst.done = true;
      const amount = Math.min(
        particleLimit - sparks.length,
        burst.confetti ? (compact ? 42 : 70) : compact ? 72 : 112,
      );
      for (let index = 0; index < amount; index++) {
        const angle = (index / amount) * Math.PI * 2 + Math.random() * 0.06;
        // Alternate a bright outer crown and a slower inner bloom.
        const speed = ((compact ? 85 : 145) + Math.random() * 55) * (index % 3 ? 1 : 0.55);
        sparks.push({
          x: burst.confetti ? Math.random() * width.value : burst.x * width.value,
          y: burst.y * height.value,
          vx: burst.confetti ? (Math.random() - 0.5) * 100 : Math.cos(angle) * speed,
          vy: burst.confetti ? 30 + Math.random() * 65 : Math.sin(angle) * speed,
          life: burst.confetti ? 3.2 + Math.random() : 1.7 + Math.random() * 0.7,
          age: 0,
          color: burst.confetti
            ? festive[index % festive.length]!
            : index % 4
              ? burst.color
              : '#fff9e4',
          size: burst.confetti ? 3 + Math.random() * 4 : 1.2 + Math.random() * 1.8,
          confetti: burst.confetti,
          rotation: angle,
          gravity: burst.confetti ? 28 : 48,
          drag: burst.confetti ? 0.25 : 0.65,
        });
      }
    }
    // Fixed pool limits protect the live 3D scene, even during a long finale.
    sparks = sparks.filter((spark) => spark.age < spark.life);
    for (const spark of sparks) {
      spark.age += dt;
      spark.x += spark.vx * dt;
      spark.y += spark.vy * dt;
      spark.vy += spark.gravity * dt;
      spark.vx *= Math.exp(-dt * spark.drag);
      context.globalAlpha = Math.pow(Math.max(0, 1 - spark.age / spark.life), 0.65);
      context.fillStyle = spark.color;
      if (spark.confetti) {
        context.globalCompositeOperation = 'source-over';
        context.save();
        context.translate(spark.x, spark.y);
        context.rotate(spark.rotation + spark.age * 3);
        context.fillRect(-spark.size / 2, -spark.size / 2, spark.size, spark.size * 0.5);
        context.restore();
      } else {
        context.globalCompositeOperation = 'lighter';
        context.strokeStyle = spark.color;
        context.lineWidth = spark.size;
        context.beginPath();
        context.moveTo(spark.x - spark.vx * 0.07, spark.y - spark.vy * 0.07);
        context.lineTo(spark.x, spark.y);
        context.stroke();
        context.beginPath();
        context.arc(spark.x, spark.y, spark.size * 0.7, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    if (elapsed < cue!.duration && (sparks.length || bursts.some((burst) => !burst.done)))
      frame = requestAnimationFrame(draw);
    else stopParticles();
  }
  frame = requestAnimationFrame(draw);
}
watch(() => [props.cue?.id, props.reducedMotion], launch, { flush: 'post' });
const visibility = () => {
  if (document.hidden) stopParticles();
};
onMounted(() => {
  resize();
  launch();
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', visibility);
});
onBeforeUnmount(() => {
  stopParticles();
  window.removeEventListener('resize', resize);
  document.removeEventListener('visibilitychange', visibility);
});
</script>

<template>
  <div ref="host" class="arena-show" :class="{ 'motion-reduced': reducedMotion }">
    <canvas ref="canvas" class="arena-fireworks" aria-hidden="true"></canvas>
    <div
      v-if="cue && cue.intensity !== 'light'"
      :key="cue.id + '-aura'"
      class="arena-event-aura"
      :class="'tone-' + cue.tone"
      aria-hidden="true"
    >
      <i></i><i></i>
    </div>
    <Transition name="arena-highlight" mode="out-in">
      <section
        v-if="cue && ['play', 'finish', 'alarm', 'wind', 'deal'].includes(cue.kind)"
        :key="cue.id"
        class="arena-highlight"
        :class="[
          'tone-' + cue.tone,
          'intensity-' + cue.intensity,
          { 'has-cards': cue.cards.length },
        ]"
        role="status"
        aria-atomic="true"
      >
        <div class="highlight-meta">
          <span class="highlight-live-dot" aria-hidden="true"></span>{{ cue.eyebrow
          }}<span class="highlight-player">{{ game.agents[cue.seat]?.name }}</span>
        </div>
        <h2>{{ cue.title }}</h2>
        <div
          v-if="cue.cards.length"
          class="highlight-cards"
          :style="{ '--card-count': cue.cards.length }"
          aria-label="出牌特写"
        >
          <div
            v-for="(card, index) in cue.cards"
            :key="card.id"
            class="highlight-card"
            :class="{ red: red(card), wild: card.suit === 'H' && card.rank === game.level }"
            :style="cardStyle(index, cue.cards.length)"
            :aria-label="cardName(card)"
          >
            <b>{{ rankName(card.rank) }}</b
            ><span>{{ suit(card) }}</span
            ><strong aria-hidden="true">{{ suit(card) }}</strong
            ><small v-if="card.suit === 'H' && card.rank === game.level">逢人配</small>
          </div>
        </div>
        <p>{{ cue.subtitle }}</p>
        <div
          class="highlight-timer"
          :style="{ '--cue-duration': cue.duration + 'ms' }"
          aria-hidden="true"
        ></div>
      </section>
    </Transition>
    <div
      v-for="reaction in reactions"
      :key="reaction.seat + ':' + reaction.mood"
      class="actor-reaction"
      :class="'reaction-' + reaction.mood"
      :style="reactionStyle(reaction.seat)"
      aria-hidden="true"
    >
      <span class="reaction-mark">{{
        reaction.mood === 'shocked'
          ? '!!'
          : reaction.mood === 'sad'
            ? '…'
            : reaction.mood === 'worried'
              ? '?'
              : '✦'
      }}</span
      ><span>{{ moodLabels[reaction.mood!] }}</span>
    </div>
  </div>
</template>
