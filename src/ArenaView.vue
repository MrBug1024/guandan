<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ArenaScene from './ArenaScene.vue';
import { gameFrame, rankName, type PublicGame } from '../shared/types';
import { replaySession } from './replay';
import './arena.css';

const route = useRoute(),
  router = useRouter(),
  state = ref<PublicGame>(),
  connected = ref(false);
const pending = ref(false),
  toast = ref(''),
  showFeed = ref(false),
  speech = ref(false),
  now = ref(Date.now()),
  viewportWidth = ref(innerWidth);
const replayIndex = ref(replaySession.value?.game.history.length ?? 0);
const speechReady = ref(false);
function enableBroadcastAudio() {
  const voice = new SpeechSynthesisUtterance('直播解说已开启');
  voice.lang = 'zh-CN';
  voice.onerror = (event) => { if (event.error === 'not-allowed') speechReady.value = false; };
  speechSynthesis.speak(voice);
  speechReady.value = true;
}
const playerAnchors = ref<{ x: number; y: number }[]>([]);
function playerLabelStyle(seat: number) {
  const anchor = playerAnchors.value[seat];
  if (!anchor || (seat !== 1 && seat !== 3)) return {};
  const compact = viewportWidth.value <= 700;
  const halfWidth = compact ? 66 : 90;
  const offset = compact ? 45 : 75;
  return {
    left: `${Math.max(halfWidth + 12, Math.min(viewportWidth.value - halfWidth - 12, anchor.x + (seat === 1 ? -offset : offset)))}px`,
    top: `${anchor.y + 12}px`,
    right: 'auto',
    bottom: 'auto',
    transform: 'translate(-50%, -50%)',
  };
}
const broadcastMode = computed(() => route.query.broadcast === '1'),
  portrait = computed(() => route.query.layout === 'portrait');
const colors = ['#f2adbd', '#aabef6', '#add8bc', '#f3ce93'],
  icons = ['✿', '◇', '●', '✦'];
let stream: EventSource,
  clock: ReturnType<typeof setInterval>,
  toastTimer: ReturnType<typeof setTimeout>;
let spokenSeq = -1,
  spokenGame = '';
async function setPresentation(settings: { speech?: boolean; showFeed?: boolean }) {
  await action('presentation', settings);
}
const view = computed<PublicGame | undefined>(() => {
  const r = replaySession.value;
  if (!r) return state.value;
  const history = r.game.history.slice(0, replayIndex.value),
    frame = history.at(-1)?.after ?? gameFrame(toRaw(r.initial));
  const used = new Set(
    history.filter((e) => e.seat === 0).flatMap((e) => e.move?.cards.map((c) => c.id) ?? []),
  );
  const { hands, ...game } = r.game;
  return {
    ...game,
    ...frame,
    history,
    visibleHand: r.initial.hands[0].filter((c) => !used.has(c.id)),
    viewpointSeat: 0,
    agents: r.agents,
    thinking: null,
    delayMs: 1800,
    autoNext: false,
    nextRoundAt: null,
  };
});
const currentEntry = computed(() =>
  view.value?.history.filter((e) => e.move && e.after?.round === view.value?.round).at(-1),
);
const recent = computed(() => view.value?.history.slice(-12).reverse() ?? []);
const hand = computed(() =>
  [...(view.value?.visibleHand ?? [])].sort((a, b) => {
    const strength = (r: number) => (r >= 15 ? r + 2 : r === view.value?.level ? 16 : r);
    return (
      strength(a.rank) - strength(b.rank) ||
      a.suit.localeCompare(b.suit) ||
      a.id.localeCompare(b.id)
    );
  }),
);
const countdown = computed(() =>
  view.value?.nextRoundAt === null || !view.value?.nextRoundAt
    ? null
    : Math.max(0, Math.ceil((view.value.nextRoundAt - now.value) / 1000)),
);
const roundOver = computed(() => ['round-over', 'match-over'].includes(view.value?.status ?? ''));
const status = computed(
  () =>
    ({
      ready: '等待开始',
      running: view.value?.thinking !== null ? '正在思考' : '正在对局',
      paused: '对局暂停',
      'round-over': '本局结束',
      'match-over': '比赛结束',
    })[view.value?.status ?? 'ready'],
);
function notify(message: string) {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ''), 4500);
}
async function action(name: string, presentation?: { speech?: boolean; showFeed?: boolean }) {
  if (replaySession.value) return;
  pending.value = true;
  try {
    const token = sessionStorage.getItem('control-token');
    const response = await fetch('/api/control', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ action: name, ...(presentation ? { presentation } : {}) }),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error);
    state.value = data;
  } catch (e) {
    notify((e as Error).message);
  } finally {
    pending.value = false;
  }
}
async function leave() {
  if (!replaySession.value) await action('pause');
  replaySession.value = undefined;
  await router.push('/studio');
}
function handStyle(i: number) {
  const middle = (hand.value.length - 1) / 2,
    available = Math.min(700, viewportWidth.value * (viewportWidth.value < 700 ? 0.88 : 0.68)),
    step = Math.min(30, (available - 49) / Math.max(1, hand.value.length - 1));
  return {
    left: `calc(50% + ${(i - middle) * step}px)`,
    transform: `translateX(-50%) translateY(${Math.pow((i - middle) / Math.max(1, middle), 2) * 12}px) rotate(${(i - middle) * 0.6}deg)`,
    zIndex: i + 1,
  };
}
function resize() {
  viewportWidth.value = innerWidth;
}
onMounted(() => {
  window.addEventListener('resize', resize);
  clock = setInterval(() => (now.value = Date.now()), 200);
  stream = new EventSource('/api/events');
  stream.onmessage = (e) => {
    state.value = JSON.parse(e.data);
    connected.value = true;
    speech.value = state.value?.presentation?.speech ?? false;
    showFeed.value = state.value?.presentation?.showFeed ?? false;
    if (!speech.value) speechSynthesis.cancel();
    const entry = state.value?.history.at(-1);
    if (spokenGame !== state.value?.id) {
      spokenGame = state.value?.id ?? '';
      spokenSeq = entry?.seq ?? -1;
    }
    if (speech.value && speechReady.value && broadcastMode.value && entry && entry.seq > spokenSeq && entry.seat >= 0) {
      spokenSeq = entry.seq;
      const voice = new SpeechSynthesisUtterance(
        `${state.value!.agents[entry.seat].name}，${entry.move?.label ?? ''}`,
      );
      voice.lang = 'zh-CN';
      voice.onerror = (event) => { if (event.error === 'not-allowed') speechReady.value = false; };
      speechSynthesis.cancel();
      speechSynthesis.speak(voice);
    }
    if (entry) spokenSeq = entry.seq;
  };
  stream.onerror = () => (connected.value = false);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', resize);
  stream?.close();
  clearInterval(clock);
  clearTimeout(toastTimer);
  speechSynthesis.cancel();
});
</script>
<template>
  <div
    class="match-page"
    :class="{ 'clean-broadcast': broadcastMode, 'match-portrait': portrait, 'feed-open': showFeed }"
  >
    <template v-if="view">
      <ArenaScene
        :turn="view.turn"
        :thinking="view.thinking"
        :finished="view.finished"
        :hand="hand"
        :counts="view.counts"
        :entry="currentEntry"
        :history="view.history"
        :round="view.round"
        :level="view.level"
        :last="view.last"
        :last-seat="view.lastSeat"
        :game-id="view.id"
        @anchors="playerAnchors = $event"
      />
      <div class="room-vignette"></div>
      <button v-if="broadcastMode && speech && !speechReady" class="broadcast-audio-start" @click="enableBroadcastAudio">🔊 开启直播声音</button>
      <header class="match-header">
        <div class="match-brand">
          <span class="club-mark">g</span>
          <div>
            <strong>掼蛋 AI 俱乐部</strong
            ><small>{{ replaySession ? 'REPLAY / 赛事回放' : 'FOUR MINDS. ONE TABLE.' }}</small>
          </div>
        </div>
        <div class="match-score">
          <span :style="{ color: colors[0] }"
            >{{ view.agents[0].name }} × {{ view.agents[2].name }}
            <b>{{ rankName(view.levels[0]) }}</b></span
          >
          <div>
            <small>第 {{ String(view.round).padStart(2, '0') }} 局</small
            ><strong>打 {{ rankName(view.level) }}</strong>
          </div>
          <span :style="{ color: colors[1] }"
            ><b>{{ rankName(view.levels[1]) }}</b> {{ view.agents[1].name }} ×
            {{ view.agents[3].name }}</span
          >
        </div>
        <div class="match-top-actions">
          <span class="match-connection" :class="{ online: connected }"
            >● {{ connected ? status : '重新连接中' }}</span
          ><button v-if="!broadcastMode" title="返回工作室并暂停" @click="leave">↗ 工作室</button>
        </div>
      </header>
      <aside class="match-notice" aria-label="文明观赛声明">
        <strong>禁止赌博</strong>
        <span>AI 掼蛋演示 · 文明观赛</span>
        <small>无下注 · 无现金输赢</small>
      </aside>
      <div
        v-for="(agent, i) in view.agents"
        :key="i"
        :class="[
          'player-label',
          'player-label-' + i,
          { active: view.turn === i, finished: view.finished.includes(i) },
        ]"
        :style="{ '--player-color': colors[i], ...playerLabelStyle(i) }"
      >
        <div class="player-symbol">{{ icons[i] }}</div>
        <div>
          <strong
            >{{ agent.name }}
            <small>{{
              i === 0 ? '近侧视角' : i === 2 ? '对家搭档' : i === 1 ? '左侧' : '右侧'
            }}</small></strong
          >
          <p>
            <span>{{
              view.finished.includes(i)
                ? view.finished.length === 4 &&
                  view.finished[0] % 2 === view.finished[1] % 2 &&
                  view.counts[i] > 0
                  ? '双下'
                  : ['头游', '二游', '三游', '末游'][view.finished.indexOf(i)]
                : `${view.counts[i]} 张`
            }}</span
            ><em v-if="view.thinking === i">思考 <i class="thinking">•••</i></em
            ><em v-else-if="view.turn === i && !roundOver">轮到出牌</em
            ><span v-else>{{ i === 0 ? '手牌可见' : '手牌隐藏' }}</span>
          </p>
        </div>
      </div>
      <div
        v-if="currentEntry && !roundOver"
        class="action-bubble"
        :class="'bubble-' + currentEntry.seat"
        :key="`${view.id}-${currentEntry.seq}`"
      >
        <span>{{
          currentEntry.move?.kind === 'pass'
            ? '这轮让一让。'
            : currentEntry.move?.label.split(' · ')[0]
        }}</span
        ><small>{{ view.agents[currentEntry.seat].name }}</small>
      </div>
      <div class="table-status">
        <span v-if="view.last"
          >{{ view.agents[view.lastSeat].name }} · {{ view.last.label.split(' · ')[0] }}</span
        ><span v-else-if="!roundOver">{{
          view.status === 'ready' ? '等大家准备好' : '新一轮 · 自由领出'
        }}</span>
      </div>
      <section v-if="roundOver" class="round-result">
        <span class="result-eyebrow">{{
          view.status === 'match-over' ? 'MATCH COMPLETE' : 'ROUND COMPLETE'
        }}</span>
        <h2>{{ view.winner === 0 ? '桃色联盟' : '星光联盟' }}获胜 <span>✦</span></h2>
        <div class="finish-order">
          <div v-for="(seat, i) in view.finished" :key="seat">
            <small>{{
              i >= 2 && view.finished[0] % 2 === view.finished[1] % 2
                ? '双下'
                : ['头游', '二游', '三游', '末游'][i]
            }}</small
            ><strong :style="{ color: colors[seat] }">{{ view.agents[seat].name }}</strong>
          </div>
        </div>
        <p v-if="countdown !== null">
          休息一下，<b>{{ countdown }}</b> 秒后开始下一局
        </p>
        <p v-else-if="view.status === 'match-over'">已打过 A，本场比赛结束。</p>
        <p v-else>自动续局已暂停，可以继续下一局。</p>
        <button
          v-if="!broadcastMode && view.status === 'round-over'"
          class="ghost"
          :disabled="pending"
          @click="action(countdown !== null ? 'pause' : 'start')"
        >
          {{ countdown !== null ? '暂停连续对局' : '继续下一局 →' }}</button
        ><button
          v-if="!broadcastMode && view.status === 'match-over'"
          class="primary"
          @click="action('reset')"
        >
          重新比赛
        </button>
      </section>
      <div class="hand-zone">
        <div class="hand-heading">
          <strong>✿ {{ view.agents[0].name }}的手牌</strong>
          <span class="hand-count">剩余 {{ hand.length }} 张</span>
          <span class="hand-wild">♥{{ rankName(view.level) }} 逢人配</span>
        </div>
        <div class="visible-hand" :class="{ empty: !hand.length }">
          <div
            v-for="(card, i) in hand"
            :key="card.id"
            class="spectator-card"
            :class="{
              red: card.suit === 'H' || card.suit === 'D' || card.rank === 16,
              wild: card.suit === 'H' && card.rank === view.level,
            }"
            :style="handStyle(i)"
          >
            <b>{{ rankName(card.rank) }}</b
            ><span>{{
              card.suit === 'J' ? '★' : { S: '♠', H: '♥', C: '♣', D: '♦' }[card.suit]
            }}</span
            ><small v-if="card.suit === 'H' && card.rank === view.level">配</small>
          </div>
          <p v-if="!hand.length">手牌已出完，等待搭档。</p>
        </div>
      </div>
      <aside v-if="showFeed" class="match-feed">
        <h2>牌桌动态 <button v-if="!broadcastMode" @click="setPresentation({ showFeed: false })">×</button></h2>
        <article v-for="e in recent" :key="e.seq">
          <strong :style="{ color: e.seat < 0 ? '#dec69d' : colors[e.seat] }"
            >{{ e.seat < 0 ? '裁判' : view.agents[e.seat].name }}
            <small>#{{ e.seq }}</small></strong
          >
          <p>{{ e.move?.label ?? e.text }}</p>
          <small>{{ e.source }}{{ e.error ? ' · 已兜底' : '' }}</small>
        </article>
      </aside>
      <div v-if="view.tribute.length" class="match-tribute">{{ view.tribute.join('；') }}</div>
      <footer v-if="!broadcastMode" class="match-controls">
        <button @click="setPresentation({ showFeed: !showFeed })">☷ {{ showFeed ? '收起' : '对局动态' }}</button
        ><button
          :disabled="
            pending ||
            view.thinking !== null ||
            view.status === 'running' ||
            roundOver ||
            !!replaySession
          "
          @click="action('step')"
        >
          ▷ 单步</button
        ><button
          class="match-play"
          :disabled="pending || view.status === 'match-over' || !!replaySession"
          @click="action(view.status === 'running' || countdown !== null ? 'pause' : 'start')"
        >
          {{ view.status === 'running' || countdown !== null ? 'Ⅱ 暂停' : '▶ 继续对局' }}</button
        ><label><input type="checkbox" :checked="speech" @change="setPresentation({ speech: ($event.target as HTMLInputElement).checked })" /> 直播解说</label
        ><span>{{ view.autoNext ? '↻ 连续对局' : '单局模式' }}</span>
      </footer>
      <div v-if="replaySession" class="match-replay">
        <button @click="replaySession = undefined">退出回放</button
        ><input
          type="range"
          aria-label="回放进度"
          v-model.number="replayIndex"
          min="0"
          :max="replaySession.game.history.length"
        /><span>{{ replayIndex }} / {{ replaySession.game.history.length }}</span>
      </div>
    </template>
    <div v-else class="match-loading">
      正在准备牌桌…<RouterLink to="/studio">返回工作室</RouterLink>
    </div>
    <div v-if="toast" class="toast" role="status">{{ toast }}</div>
  </div>
</template>
