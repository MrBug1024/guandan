<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ArenaScene from './ArenaScene.vue';
import ArenaShow from './ArenaShow.vue';
import ArenaCeremony from './ArenaCeremony.vue';
import { actorMood } from './arena-events';
import { useArenaShow } from './useArenaShow';
import type { PlayerAnchor } from './arena-projection';
import ArenaRoster from './ArenaRoster.vue';
import RobotPortrait from './RobotPortrait.vue';
import { gameFrame, rankName, cardName, type PublicGame } from '../shared/types';
import { replaySession } from './replay';
import { admin, sharePath } from './auth';
import './arena.css';
import './arena-readability.css';

const route = useRoute(),
  router = useRouter(),
  state = ref<PublicGame>(),
  connected = ref(false);
const pending = ref(false),
  toast = ref(''),
  showFeed = ref(false),
  speech = ref(false),
  viewerError = ref('正在连接对局…'),
  now = ref(Date.now()),
  viewportWidth = ref(innerWidth);
const replaySeat = ref(0);
const replayIndex = ref(replaySession.value?.game.history.length ?? 0);
const speechReady = ref(false);
const audioError = ref('');
const audio = new Audio();
audio.preload = 'auto';
audio.playbackRate = 1;
audio.defaultPlaybackRate = 1;
audio.preservesPitch = true;
type AudioClip = {
  url: string;
  created: number;
  preload: HTMLAudioElement;
  ready: Promise<void>;
  dropped: boolean;
  failed: boolean;
};
const audioQueue: AudioClip[] = [];
const clips = new Set<AudioClip>();
let playingAudio = false,
  audioGeneration = 0,
  activeClip: AudioClip | undefined;
function releaseClip(clip: AudioClip) {
  clip.dropped = true;
  clip.preload.pause();
  clip.preload.removeAttribute('src');
  clip.preload.load();
  clips.delete(clip);
}
function stopNarration() {
  audioGeneration++;
  audioQueue.length = 0;
  playingAudio = false;
  audio.pause();
  for (const clip of clips) releaseClip(clip);
  activeClip = undefined;
}
async function playNextNarration() {
  const clip = audioQueue.shift();
  if (!clip) {
    playingAudio = false;
    return;
  }
  playingAudio = true;
  activeClip = clip;
  const generation = audioGeneration;
  await clip.ready;
  if (generation !== audioGeneration) return;
  if (clip.dropped || Date.now() - clip.created > 8000) {
    releaseClip(clip);
    activeClip = undefined;
    void playNextNarration();
    return;
  }
  if (clip.failed) {
    stopNarration();
    speechReady.value = false;
    audioError.value = '解说生成失败，请点击重试开启声音。';
    return;
  }
  audio.playbackRate = 1;
  audio.src = clip.url;
  void audio.play().catch((error) => {
    if (error?.name === 'AbortError' || generation !== audioGeneration) return;
    stopNarration();
    speechReady.value = false;
    audioError.value = '解说播放失败，请点击重试开启声音。';
  });
}
audio.onended = () => {
  if (activeClip) releaseClip(activeClip);
  activeClip = undefined;
  void playNextNarration();
};
function narrationUrl(parameters: string) {
  return `/api/narration${spectatorQuery.value || '?'}${spectatorQuery.value ? '&' : ''}${parameters}`;
}
async function enableBroadcastAudio() {
  stopNarration();
  audioError.value = '';
  playingAudio = true;
  audio.muted = false;
  audio.volume = 1;
  audio.src = narrationUrl('welcome=1');
  try {
    await audio.play();
    speechReady.value = true;
  } catch {
    playingAudio = false;
    speechReady.value = false;
    audioError.value = '声音未能播放，请检查媒体音量并重试；持续失败请联系管理员检查音频服务。';
  }
}
function speakEntry(entry: NonNullable<PublicGame['history'][number]>) {
  if (!view.value) return;
  // Prepare immediately, while the previous clip plays. Keep only the newest waiting turn.
  for (const old of audioQueue.splice(0)) releaseClip(old);
  const url = narrationUrl(`game=${encodeURIComponent(view.value.id)}&seq=${entry.seq}`);
  const preload = new Audio();
  preload.preload = 'auto';
  preload.src = url;
  const clip: AudioClip = {
    url,
    created: Date.now(),
    preload,
    ready: Promise.resolve(),
    dropped: false,
    failed: false,
  };
  clips.add(clip);
  preload.load();
  audioQueue.push(clip);
  if (!playingAudio) void playNextNarration();
}
const playerAnchors = ref<PlayerAnchor[]>([]);
const tableAnchor = ref<{ x: number; y: number }>();
const broadcastMode = computed(() => route.name === 'watch' || route.query.broadcast === '1'),
  portrait = computed(() => route.query.layout === 'portrait' || viewportWidth.value <= 700);
const spectatorQuery = computed(() => {
  const params = new URLSearchParams();
  if (route.name === 'watch') params.set('share', String(route.params.share));
  return params.size ? '?' + params.toString() : '';
});
async function shareMatch() {
  const url = `${location.origin}${sharePath.value}`;
  try {
    if (navigator.share) await navigator.share({ title: '掼蛋 AI 俱乐部 · 实时观战', url });
    else {
      await navigator.clipboard.writeText(url);
      notify('观战链接已复制');
    }
  } catch {
    notify('可在直播工作台复制观战链接');
  }
}
const colors = ['#f2adbd', '#aabef6', '#add8bc', '#f3ce93'];
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
    history
      .filter((e) => e.seat === replaySeat.value)
      .flatMap((e) => e.move?.cards.map((c) => c.id) ?? []),
  );
  const { hands, ...game } = r.game;
  return {
    ...game,
    ...frame,
    history,
    visibleHand: r.initial.hands[replaySeat.value].filter((c) => !used.has(c.id)),
    viewpointSeat: replaySeat.value,
    agents: r.agents,
    thinking: null,
    delayMs: 1800,
    autoNext: false,
    nextRoundAt: null,
  };
});
const cameraMode = computed<'first' | 'third'>(() =>
  ['round-over', 'match-over'].includes(view.value?.status ?? '')
    ? 'third'
    : (view.value?.presentation?.cameraMode ?? 'first'),
);
const { cue, reducedMotion } = useArenaShow(view);
const moods = computed(() =>
  view.value ? view.value.agents.map((_, seat) => actorMood(view.value!, cue.value, seat)) : [],
);
const relativeSeat = (seat: number) =>
  (seat - (cameraMode.value === 'third' ? 0 : (view.value?.viewpointSeat ?? 0)) + 4) % 4;
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
async function action(
  name: string,
  presentation?: {
    speech?: boolean;
    showFeed?: boolean;
    viewpointSeat?: number;
    cameraMode?: 'first' | 'third';
  },
) {
  if (replaySession.value) return;
  pending.value = true;
  try {
    const response = await fetch('/api/control', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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
  if (viewportWidth.value <= 700) {
    const middle = (hand.value.length - 1) / 2;
    const step = Math.min(22, (viewportWidth.value - 70) / Math.max(1, hand.value.length - 1));
    return {
      left: `calc(50% + ${(i - middle) * step}px)`,
      transform: `translateX(-50%) translateY(${Math.pow((i - middle) / Math.max(1, middle), 2) * 14}px) rotate(${middle ? ((i - middle) / middle) * 10 : 0}deg)`,
      zIndex: i + 1,
    };
  }
  const middle = (hand.value.length - 1) / 2,
    available = Math.min(700, viewportWidth.value * (viewportWidth.value < 700 ? 0.88 : 0.68)),
    step = Math.min(30, (available - 49) / Math.max(1, hand.value.length - 1));
  return {
    left: `calc(50% + ${(i - middle) * step}px)`,
    transform: `translateX(-50%) translateY(${Math.pow((i - middle) / Math.max(1, middle), 2) * 10}px) rotate(${((i - middle) / Math.max(1, middle)) * Math.min(14, middle * 3)}deg)`,
    zIndex: i + 1,
  };
}
function resize() {
  viewportWidth.value = innerWidth;
}
function openStream() {
  stream?.close();
  stream = new EventSource('/api/events' + spectatorQuery.value);
  stream.onmessage = (e) => {
    now.value = Date.now();
    state.value = JSON.parse(e.data);
    connected.value = true;
    speech.value = state.value?.presentation?.speech ?? false;
    showFeed.value = state.value?.presentation?.showFeed ?? false;
    if (!speech.value) stopNarration();
    const entry = state.value?.history.at(-1);
    if (spokenGame !== state.value?.id) {
      stopNarration();
      spokenGame = state.value?.id ?? '';
      spokenSeq = entry?.seq ?? -1;
    }
    if (
      speech.value &&
      speechReady.value &&
      broadcastMode.value &&
      entry &&
      entry.seq > spokenSeq
    ) {
      spokenSeq = entry.seq;
      speakEntry(entry);
    }
    if (entry) spokenSeq = entry.seq;
  };
  stream.onerror = () => (connected.value = false);
}
onMounted(async () => {
  window.addEventListener('resize', resize);
  clock = setInterval(() => (now.value = Date.now()), 200);
  try {
    const response = await fetch('/api/state' + spectatorQuery.value);
    if (!response.ok) {
      viewerError.value = broadcastMode.value
        ? '观战链接无效，请向管理员获取新的链接。'
        : '登录已过期，请重新登录。';
      if (!broadcastMode.value) await router.replace('/login');
      return;
    }
    state.value = await response.json();
  } catch {
    viewerError.value = '暂时无法连接对局，请刷新页面重试。';
    return;
  }
  openStream();
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', resize);
  stream?.close();
  clearInterval(clock);
  clearTimeout(toastTimer);
  stopNarration();
});
</script>
<template>
  <div
    class="match-page arena-broadcast"
    :class="{
      'clean-broadcast': broadcastMode,
      'match-portrait': portrait,
      'feed-open': showFeed,
      'view-third': cameraMode === 'third',
      'audio-prompt': broadcastMode && speech && !speechReady,
    }"
  >
    <div v-if="!view" class="arena-loading">
      <strong>掼蛋 AI 俱乐部</strong>
      <p>{{ viewerError }}</p>
    </div>
    <template v-if="view">
      <ArenaScene
        :camera-mode="cameraMode"
        :viewpoint-seat="view.viewpointSeat"
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
        :moods="moods"
        :reduced-motion="reducedMotion"
        :settlement="roundOver"
        :winner-team="view.winner"
        @anchors="playerAnchors = $event"
        @table-anchor="tableAnchor = $event"
      />
      <div class="room-vignette"></div>
      <ArenaShow
        :game="view"
        :cue="cue"
        :reduced-motion="reducedMotion"
        :anchors="playerAnchors"
        :camera-mode="cameraMode"
      />
      <ArenaCeremony
        :game="view"
        :now="now"
        :countdown="countdown"
        :broadcast="broadcastMode"
        :pending="pending"
        :reduced-motion="reducedMotion"
        @control="action($event)"
      />
      <div v-if="broadcastMode && speech && !speechReady" class="broadcast-audio-start">
        <button @click="enableBroadcastAudio">
          🔊 {{ audioError ? '重试开启声音' : '点击开启解说声音' }}</button
        ><small>{{ audioError || '微信与手机浏览器需要点击后才能播放声音' }}</small>
      </div>
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
          ><button v-if="!broadcastMode && admin" @click="shareMatch">分享观战</button
          ><button v-if="!broadcastMode && admin" title="返回工作室并暂停" @click="leave">
            ↗ 工作室
          </button>
        </div>
      </header>
      <details class="table-rules">
        <summary>本桌规则 ⓘ</summary>
        <p>顺时针出牌 · 首局近侧座位先手。对家为队友，两副牌每人 27 张。</p>
        <p>
          头游搭配二游／三游／末游，升 3／2／1 级，最高到 A。打 A 时队友不能是末游；本队三次尝试不过
          A 降回 2。
        </p>
        <p>单贡末游先出；双贡较大贡牌的进贡者先出；同贡按头游下一座优先。两大王抗贡后头游先出。</p>
        <p>
          还贡不大于 10 且不是红桃级牌；无合格牌时还最小非逢人配。顺子、连对和钢板允许 A
          作最小或最大，不允许绕序。
        </p>
        <p>出完后无人接牌，由对家接风。双下提前结算，未出完两位不强行区分三游和末游。</p>
      </details>
      <aside class="match-notice" aria-label="文明观赛声明">
        <strong>禁止赌博</strong>
        <span>AI 掼蛋演示 · 文明观赛</span>
        <small>无下注 · 无现金输赢</small>
      </aside>
      <ArenaRoster
        v-if="!roundOver"
        :game="view"
        :camera-mode="cameraMode"
        :reduced-motion="reducedMotion"
      />
      <div
        v-if="currentEntry && !roundOver"
        class="action-bubble"
        :class="'bubble-' + relativeSeat(currentEntry.seat)"
        :key="`${view.id}-${currentEntry.seq}`"
      >
        <span>{{
          currentEntry.move?.kind === 'pass'
            ? '这轮让一让。'
            : currentEntry.move?.label.split(' · ')[0]
        }}</span
        ><small>{{ view.agents[currentEntry.seat].name }}</small>
      </div>
      <div class="table-status" :style="tableAnchor ? { left: tableAnchor.x + 'px', top: tableAnchor.y + 'px' } : {}">
        <span v-if="view.last"
          >{{ view.agents[view.lastSeat].name }} · {{ view.last.label.split(' · ')[0] }}</span
        ><span v-else-if="!roundOver">{{
          view.status === 'ready' ? '等大家准备好' : '新一轮 · 自由领出'
        }}</span>
      </div>
      <div class="hand-zone">
        <div class="hand-heading">
          <strong
            ><RobotPortrait :seat="view.viewpointSeat" />
            {{ view.agents[view.viewpointSeat].name }} ·
            {{ cameraMode === 'third' ? '观战手牌' : '我们的手牌' }}</strong
          >
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
            ><span class="card-center" aria-hidden="true">{{
              card.suit === 'J' ? '★' : { S: '♠', H: '♥', C: '♣', D: '♦' }[card.suit]
            }}</span>
            <span class="card-bottom" aria-hidden="true">{{ rankName(card.rank) }}</span>
            <small v-if="card.suit === 'H' && card.rank === view.level">配</small>
          </div>
          <p v-if="!hand.length">手牌已出完，等待搭档。</p>
        </div>
      </div>
      <aside v-if="showFeed" class="match-feed">
        <h2>
          牌桌动态
          <button v-if="!broadcastMode" @click="setPresentation({ showFeed: false })">×</button>
        </h2>
        <article v-for="e in recent" :key="e.seq">
          <strong :style="{ color: e.seat < 0 ? '#dec69d' : colors[e.seat] }"
            >{{ e.seat < 0 ? '裁判' : view.agents[e.seat].name }}
            <small>#{{ e.seq }}</small></strong
          >
          <p>{{ e.move?.label ?? e.text }}</p>
          <small>{{ e.source }}{{ e.error ? ' · 已兜底' : '' }}</small>
        </article>
      </aside>
      <div v-if="view.tribute.length" class="match-tribute">
        {{
          view.tributeKind === 'anti'
            ? '两大王抗贡'
            : view.tributeKind === 'double'
              ? '双贡还贡已完成'
              : '单贡还贡已完成'
        }}
        · {{ view.agents[view.turn].name
        }}{{ view.tributeUntil && now < view.tributeUntil ? '先出' : '轮到出牌' }}
      </div>
      <footer v-if="!broadcastMode" class="match-controls">
        <button :disabled="pending" @click="action('restart')">↻ 重新开始</button>
        <button @click="setPresentation({ showFeed: !showFeed })">
          ☷ {{ showFeed ? '收起' : '对局动态' }}</button
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
        ><label
          ><input
            type="checkbox"
            :checked="speech"
            @change="setPresentation({ speech: ($event.target as HTMLInputElement).checked })"
          />
          直播解说</label
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
