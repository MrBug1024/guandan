<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { DEFAULT_STUDY, cardName, rankName, type DecisionTrace, type PublicGame } from '../shared/types';
import RobotPortrait from './RobotPortrait.vue';
import ArenaCeremony from './ArenaCeremony.vue';
import UiIcon from './UiIcon.vue';
import { useArenaShow } from './useArenaShow';
import { tableCall } from '../shared/voice-lines';
import { createTimedPresenter } from './timed-presenter';
import { classifyActionUpdate, makeDecisionInsight, type DecisionInsight } from './decision-insight';
import './arena-show.css';
import './mobile-broadcast.css';

const props = withDefaults(defineProps<{
  game: PublicGame;
  now: number;
  connected: boolean;
  status: string;
  speechReady: boolean;
  audioError: string;
  mode?: 'watch' | 'console';
  pending?: boolean;
  replay?: boolean;
  replayIndex?: number;
  replayLength?: number;
  notice?: string;
}>(), { mode: 'watch', pending: false, replay: false, replayIndex: 0, replayLength: 0, notice: '' });
const emit = defineEmits<{
  enableAudio: [];
  orientationNotice: [message: string];
  control: [action: 'start' | 'pause' | 'step' | 'restart'];
  share: [];
  back: [];
  replaySeek: [index: number];
  replayExit: [];
}>();

const width = ref(window.innerWidth);
const height = ref(window.innerHeight);
const watchRoot = ref<HTMLElement>();
const orientationLocked = ref(false);
let ownsFullscreen = false;
const orientationLabel = computed(() => orientationLocked.value
  ? '恢复系统自动旋转'
  : `切换为${width.value >= height.value ? '竖屏' : '横屏'}`);
const resize = () => {
  width.value = window.innerWidth;
  height.value = window.innerHeight;
};
function fullscreenChanged() {
  if (!document.fullscreenElement && orientationLocked.value) {
    screen.orientation?.unlock();
    orientationLocked.value = false;
    ownsFullscreen = false;
  }
}
async function toggleOrientation() {
  const orientation = screen.orientation as ScreenOrientation & {
    lock?: (value: 'portrait' | 'landscape') => Promise<void>;
  };
  if (orientationLocked.value) {
    orientation.unlock();
    orientationLocked.value = false;
    if (ownsFullscreen && document.fullscreenElement === watchRoot.value)
      await document.exitFullscreen().catch(() => undefined);
    ownsFullscreen = false;
    emit('orientationNotice', '已恢复系统自动旋转；页面会继续按当前屏幕方向自适应。');
    return;
  }
  if (typeof orientation?.lock !== 'function') {
    emit('orientationNotice', '当前浏览器不允许网页锁定方向。页面已自动适配；打开设备自动旋转后横放手机即可切换横屏。');
    return;
  }
  let enteredFullscreen = false;
  try {
    if (!document.fullscreenElement) {
      const element = watchRoot.value;
      if (!element?.requestFullscreen) throw new Error('fullscreen unavailable');
      await element.requestFullscreen();
      enteredFullscreen = true;
      ownsFullscreen = true;
    }
    const target = width.value >= height.value ? 'portrait' : 'landscape';
    await orientation.lock(target);
    orientationLocked.value = true;
    emit('orientationNotice', `已切换为${target === 'landscape' ? '横屏' : '竖屏'}观看；再次点击恢复系统自动旋转。`);
  } catch {
    if (enteredFullscreen && document.fullscreenElement === watchRoot.value)
      await document.exitFullscreen().catch(() => undefined);
    ownsFullscreen = false;
    emit('orientationNotice', '浏览器未允许自动切屏。页面会自动适配，请使用手机系统旋转或横竖屏锁定设置。');
  }
}
const privateTraces = ref<Record<number, DecisionTrace>>({});
let traceRequest = 0;
onMounted(() => {
  window.addEventListener('resize', resize);
  document.addEventListener('fullscreenchange', fullscreenChanged);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', resize);
  document.removeEventListener('fullscreenchange', fullscreenChanged);
  if (orientationLocked.value) screen.orientation?.unlock();
  if (ownsFullscreen && document.fullscreenElement === watchRoot.value)
    void document.exitFullscreen().catch(() => undefined);
  clearTimeout(actionCalloutTimer);
  clearTimeout(specialEffectTimer);
  insightPresenter.clear();
  traceRequest++;
});

const seatColors = ['#e97658', '#258e7b', '#bc9441', '#6874b6'];
const study = computed(() => props.game.study ?? DEFAULT_STUDY);
const entries = computed(() => props.game.history.filter(
  (entry) => entry.seat >= 0 && entry.move && (!entry.after || entry.after.round === props.game.round),
));
const latest = computed(() => entries.value.at(-1));
const activeInsight = ref<DecisionInsight | null>(null);
const typedInsight = ref('');
let typewriterFrame = 0;
function publishInsight(insight: DecisionInsight | null) {
  if (typewriterFrame) cancelAnimationFrame(typewriterFrame);
  activeInsight.value = insight;
  typedInsight.value = '';
  if (!insight) return;

  const text = `${insight.name} · ${insight.action}：${insight.rationale}${insight.tacticalRead ? ` 对手推测：${insight.tacticalRead}` : ''}`;
  const allCharacters = Array.from(text);
  const characters = allCharacters.length > 130
    ? [...allCharacters.slice(0, 129), '…']
    : allCharacters;
  const startedAt = performance.now();
  const typeNext = (now: number) => {
    const progress = Math.min(1, (now - startedAt) / 1500);
    typedInsight.value = characters.slice(0, Math.ceil(characters.length * progress)).join('');
    if (progress < 1) typewriterFrame = requestAnimationFrame(typeNext);
    else typewriterFrame = 0;
  };
  typewriterFrame = requestAnimationFrame(typeNext);
}
const insightPresenter = createTimedPresenter<DecisionInsight>(publishInsight, {
  minimumMs: 4000,
  visibleMs: 4300,
});
const trickEntries = computed(() => {
  const rows = entries.value;
  let lead = -1;
  for (let index = rows.length - 1; index >= 0; index--) {
    if (rows[index].move?.kind !== 'pass') {
      lead = index;
      break;
    }
  }
  return rows.slice(lead < 0 ? Math.max(0, rows.length - 4) : lead).slice(-4);
});
const leadEntry = computed(() => [...trickEntries.value].reverse().find(
  (entry) => entry.move?.kind !== 'pass',
));
const passEntries = computed(() => trickEntries.value.filter((entry) => entry.move?.kind === 'pass'));
const seats = computed(() => {
  const bottom = props.game.viewpointSeat;
  const positions = [
    { seat: (bottom + 2) % 4, slot: 'top' },
    { seat: (bottom + 1) % 4, slot: 'left' },
    { seat: (bottom + 3) % 4, slot: 'right' },
    { seat: bottom, slot: 'bottom' },
  ] as const;
  return positions.map(({ seat, slot }) => ({
    seat,
    slot,
    agent: props.game.agents[seat],
    count: props.game.counts[seat] ?? 0,
    active: (props.game.thinking ?? props.game.turn) === seat &&
      !props.game.finished.includes(seat) && ['ready', 'running', 'paused'].includes(props.game.status),
    thinking: props.game.thinking === seat && props.game.status === 'running',
    finished: props.game.finished.includes(seat),
    partner: seat % 2 === bottom % 2,
  }));
});
const activeSeat = computed(() => props.game.thinking ?? props.game.turn);
const leadPosition = computed(() => {
  if (!leadEntry.value) return 'from-top';
  return ['from-bottom', 'from-left', 'from-top', 'from-right'][
    (leadEntry.value.seat - props.game.viewpointSeat + 4) % 4
  ] ?? 'from-top';
});
const flyingSeq = ref(-1);
const actionCalloutSeq = ref(-1);
const specialEffectSeq = ref(-1);
let actionCalloutTimer: ReturnType<typeof setTimeout> | undefined;
let specialEffectTimer: ReturnType<typeof setTimeout> | undefined;
const actionCallout = computed(() => {
  const entry = entries.value.find((item) => item.seq === actionCalloutSeq.value);
  if (!entry?.move) return undefined;
  return {
    seq: entry.seq,
    seat: entry.seat,
    text: entry.voiceLine ?? tableCall(entry.move),
  };
});
function passCall(entry: PublicGame['history'][number]) {
  if (!entry.move) return '过牌';
  return entry.voiceLine ?? tableCall(
    entry.move,
    entry.move.kind === 'pass' && entry.decision?.method !== 'forced',
  );
}
watch(
  () => [props.game.id, props.game.round, latest.value?.seq] as const,
  ([id, round, seq], previous) => {
    const update = classifyActionUpdate(
      { gameId: id, round, seq },
      previous ? { gameId: previous[0], round: previous[1], seq: previous[2] } : undefined,
    );
    if (update === 'unchanged') return;
    const entry = latest.value;
    clearTimeout(actionCalloutTimer);
    clearTimeout(specialEffectTimer);
    if (update === 'reset') {
      insightPresenter.clear();
      flyingSeq.value = -1;
      actionCalloutSeq.value = -1;
      specialEffectSeq.value = -1;
      return;
    }
    if (!entry) return;
    const trace = privateTraces.value[entry.seq] ?? entry.decision;
    const insight = makeDecisionInsight(
      entry,
      trace,
      props.game.agents[entry.seat]?.name ?? 'AI',
      props.game.viewpointSeat,
    );
    if (insight) insightPresenter.show(insight);
    flyingSeq.value = entry.move?.kind !== 'pass' ? entry.seq : -1;
    actionCalloutSeq.value = entry.seq;
    actionCalloutTimer = setTimeout(() => {
      if (actionCalloutSeq.value === entry.seq) actionCalloutSeq.value = -1;
    }, 2100);
    const kind = entry.move?.kind;
    if (kind && ['bomb', 'kings', 'flush', 'plate'].includes(kind)) {
      specialEffectSeq.value = entry.seq;
      specialEffectTimer = setTimeout(() => {
        if (specialEffectSeq.value === entry.seq) specialEffectSeq.value = -1;
      }, 950);
    } else {
      specialEffectSeq.value = -1;
    }
  },
  { immediate: true },
);
const hand = computed(() => [...props.game.visibleHand].sort(
  (a, b) => a.rank - b.rank || a.suit.localeCompare(b.suit) || a.id.localeCompare(b.id),
));
const consoleMode = computed(() => props.mode === 'console');
const { reducedMotion } = useArenaShow(computed(() => props.game));
const nextRoundCountdown = computed(() => props.game.nextRoundAt && props.game.nextRoundAt > props.now
  ? Math.ceil((props.game.nextRoundAt - props.now) / 1000)
  : null);
const canStep = computed(() => !props.pending && props.game.thinking === null && props.game.status !== 'running' && !props.replay);
const canRun = computed(() => !props.pending && props.game.status !== 'match-over' && !props.replay);
function ceremonyControl(action: string) {
  emit('control', action === 'reset' ? 'restart' : action as 'start' | 'pause' | 'step' | 'restart');
}
watch(
  () => [props.mode, props.game.id, props.game.round, props.game.history.length],
  async () => {
    const request = ++traceRequest;
    if (props.mode !== 'console') return;
    try {
      const response = await fetch('/api/decisions');
      if (!response.ok) return;
      const data = await response.json();
      if (request !== traceRequest || data.gameId !== props.game.id || data.round !== props.game.round) return;
      privateTraces.value = Object.fromEntries(
        data.entries.filter((entry: { decision?: DecisionTrace }) => entry.decision)
          .map((entry: { seq: number; decision: DecisionTrace }) => [entry.seq, entry.decision]),
      );
    } catch {}
  },
  { immediate: true },
);
function handStyle(index: number) {
  const middle = (hand.value.length - 1) / 2;
  const step = Math.max(7, Math.min(23, (width.value - 36) / Math.max(1, hand.value.length - 1)));
  const offset = index - middle;
  return {
    left: `calc(50% + ${offset * step}px)`,
    transform: `translateX(-50%) translateY(${Math.pow(offset / Math.max(1, middle), 2) * 5}px)`,
    zIndex: index + 1,
  };
}
function suitSymbol(suit: string) {
  return suit === 'J' ? '★' : ({ S: '♠', H: '♥', C: '♣', D: '♦' } as Record<string, string>)[suit] ?? suit;
}
function cardTone(card: { suit: string; rank: number }) {
  return { red: card.suit === 'H' || card.suit === 'D' || card.rank === 16, wild: card.suit === 'H' && card.rank === props.game.level };
}
</script>

<template>
  <main ref="watchRoot" class="game-watch match-page" :class="[{ 'console-mode': consoleMode }, 'mode-' + mode]">
    <section class="felt-table" aria-label="实时掼蛋牌桌">
      <div class="table-rim"><div class="table-felt">
        <header class="watch-header">
          <div class="watch-brand"><b>AI/4</b><span><strong>AI 掼蛋研究直播</strong><small>{{ study.title }} · {{ study.question }}</small></span></div>
          <section class="match-scoreline" aria-label="赛况">
            <div class="team-score team-a"><span>A 队</span><strong>{{ game.agents[0].name }} <i>+</i> {{ game.agents[2].name }}</strong><b>{{ rankName(game.levels[0]) }}</b></div>
            <div class="round-score"><small>第 {{ String(game.round).padStart(2, '0') }} 局</small><strong>打 {{ rankName(game.level) }}</strong><span>{{ status }}</span></div>
            <div class="team-score team-b"><b>{{ rankName(game.levels[1]) }}</b><strong>{{ game.agents[1].name }} <i>+</i> {{ game.agents[3].name }}</strong><span>B 队</span></div>
          </section>
          <div class="watch-tools">
            <span class="live-indicator" :class="{ online: connected }"><i></i>{{ connected ? 'LIVE' : '重连中' }}</span>
            <button v-if="consoleMode" class="tool-button" @click="emit('share')">分享</button>
            <button v-if="mode === 'watch' && width <= 900" class="orientation-toggle" :class="{ enabled: orientationLocked }" :aria-label="orientationLabel" :title="orientationLabel" @click="toggleOrientation"><UiIcon name="orientation" :size="16" /></button>
            <button v-if="mode === 'watch'" class="audio-toggle" :class="{ enabled: speechReady }" :title="audioError || '短喊声与牌型音效'" @click="emit('enableAudio')">{{ speechReady ? '关闭声音' : '开启牌桌声音' }}</button>
          </div>
        </header>

        <div class="table-mark"><span>AI/4 · GUANDAN ARENA</span><b>{{ game.finished.length }}/4 出完</b></div>

        <article v-for="seat in seats.filter((item) => item.slot !== 'bottom')" :key="seat.seat" class="player-seat" :class="['seat-' + seat.slot, { active: seat.active, thinking: seat.thinking, finished: seat.finished, 'has-action': actionCallout?.seat === seat.seat }]" :style="{ '--seat-color': seatColors[seat.seat] }">
          <RobotPortrait :seat="seat.seat" />
          <div class="seat-identity"><div class="seat-name-line"><strong>{{ seat.agent.name }}</strong><i class="seat-rank">{{ rankName(game.levels[seat.seat % 2]) }}级</i></div><small>{{ seat.partner ? '同队搭档' : '对手' }} · {{ seat.finished ? '已出完' : seat.thinking ? '思考中' : seat.active ? game.status === 'paused' ? '下个行动' : '行动位' : '等待' }}</small></div>
          <b class="seat-card-count">{{ seat.finished ? '完' : seat.count }}</b>
          <div v-if="!seat.finished" class="hidden-cards" aria-label="未公开手牌"><i v-for="cardIndex in Math.min(seat.count, 5)" :key="cardIndex"></i></div>
          <span v-if="actionCallout?.seat === seat.seat" :key="actionCallout.seq" class="seat-action" aria-live="polite">{{ actionCallout.text }}</span>
        </article>

        <div class="trick-table" :style="leadEntry ? { '--actor-color': seatColors[leadEntry.seat] } : undefined" aria-label="本轮已出动作">
          <div class="trick-caption"><span>本轮出牌</span><small v-if="latest">#{{ String(latest.seq).padStart(3, '0') }}</small></div>
          <div v-if="leadEntry" class="lead-play">
            <div class="lead-cards" :class="[leadPosition, { 'flight-active': leadEntry.seq === flyingSeq }]">
              <span v-for="(card, index) in leadEntry.move?.cards ?? []" :key="card.id" class="played-card" :class="cardTone(card)" :style="{ '--card-index': index }"><b>{{ rankName(card.rank) }}</b><small>{{ suitSymbol(card.suit) }}</small></span>
            </div>
            <div v-if="passEntries.length" class="pass-stamps" aria-label="本轮过牌记录"><span v-for="entry in passEntries" :key="entry.seq" :class="{ forced: entry.voiceLine === '要不起' || entry.decision?.method === 'forced' }">{{ game.agents[entry.seat]?.name }} · {{ passCall(entry) }}</span></div>
          </div>
          <p v-if="!leadEntry" class="trick-empty">首轮正在发牌，等待第一手。</p>
          <div v-if="leadEntry && specialEffectSeq === leadEntry.seq" class="special-impact" :class="['impact-' + leadEntry.move?.kind, leadPosition]" :style="{ '--actor-color': seatColors[leadEntry.seat] }" aria-hidden="true"></div>
        </div>

        <Transition name="hand-thought">
          <section v-if="activeInsight" :key="activeInsight.seq" class="hand-thought" aria-label="AI 心理盘算" aria-live="off">
            <p>{{ typedInsight }}</p>
          </section>
        </Transition>

        <ArenaCeremony
          :game="game"
          :now="now"
          :countdown="nextRoundCountdown"
          :broadcast="!consoleMode"
          :pending="pending"
          :reduced-motion="reducedMotion"
          @control="ceremonyControl"
        />

        <article class="player-seat seat-bottom" :class="{ active: seats.find((seat) => seat.slot === 'bottom')?.active, thinking: seats.find((seat) => seat.slot === 'bottom')?.thinking, finished: seats.find((seat) => seat.slot === 'bottom')?.finished, 'has-action': actionCallout?.seat === game.viewpointSeat }" :style="{ '--seat-color': seatColors[game.viewpointSeat] }">
          <RobotPortrait :seat="game.viewpointSeat" />
          <div class="seat-identity"><div class="seat-name-line"><strong>{{ game.agents[game.viewpointSeat].name }}</strong><i class="seat-rank">{{ rankName(game.levels[game.viewpointSeat % 2]) }}级</i></div><small>当前观察席 · {{ game.finished.includes(game.viewpointSeat) ? '已出完' : seats.find((seat) => seat.slot === 'bottom')?.thinking ? '思考中' : activeSeat === game.viewpointSeat ? '行动位' : '等待' }}</small></div>
          <b class="seat-card-count">{{ game.finished.includes(game.viewpointSeat) ? '完' : hand.length }}</b>
          <span v-if="actionCallout?.seat === game.viewpointSeat" :key="actionCallout.seq" class="seat-action" aria-live="polite">{{ actionCallout.text }}</span>
        </article>

        <section class="own-hand" aria-label="当前观察席手牌">
          <header>
            <span class="hand-summary">{{ hand.length }} 张 <i>·</i> ♥{{ rankName(game.level) }} 逢人配</span>
          </header>
          <div class="hand-cards"><div v-for="(card, index) in hand" :key="card.id" class="hand-card" :class="cardTone(card)" :style="handStyle(index)" :aria-label="cardName(card)"><b>{{ rankName(card.rank) }}</b><small>{{ suitSymbol(card.suit) }}</small><i v-if="card.suit === 'H' && card.rank === game.level">配</i></div><p v-if="!hand.length">手牌已出完</p></div>
        </section>

        <nav v-if="consoleMode" class="console-controls" aria-label="对局控制">
          <div v-if="replay" class="replay-controls"><button @click="emit('replayExit')">退出回放</button><input :value="replayIndex" type="range" min="0" :max="replayLength" aria-label="回放进度" @input="emit('replaySeek', Number(($event.target as HTMLInputElement).value))"/><span>{{ replayIndex }} / {{ replayLength }}</span></div>
          <template v-else>
            <button class="control-secondary" :disabled="!canStep" @click="emit('control', 'step')">单步</button>
            <button class="control-primary" :disabled="!canRun" @click="emit('control', game.status === 'running' ? 'pause' : 'start')">{{ game.status === 'running' ? '暂停' : '继续' }}</button>
            <button class="control-secondary" :disabled="pending" @click="emit('control', 'restart')">重开</button>
            <button class="control-secondary" @click="emit('back')">工作室</button>
          </template>
        </nav>
      </div></div>
      <p v-if="notice" class="table-notice" role="status">{{ notice }}</p>
    </section>
  </main>
</template>
