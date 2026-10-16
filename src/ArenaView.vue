<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { gameFrame, type PublicGame } from '../shared/types';
import { replaySession } from './replay';
import { sharePath } from './auth';
import MobileBroadcast from './MobileBroadcast.vue';
import { playTableEffect, enableTableAudio, speakTableLine, stopTableVoice } from './table-audio';
import { tableVoiceText } from '../shared/voice-lines';

const route = useRoute();
const router = useRouter();
const state = ref<PublicGame>();
const connected = ref(false);
const pending = ref(false);
const speechReady = ref(false);
const audioError = ref('');
const notice = ref('');
const viewerError = ref('正在连接牌桌…');
const now = ref(Date.now());
const replayIndex = ref(replaySession.value?.game.history.length ?? 0);
const replaySeat = ref(0);
const broadcastMode = computed(() => route.name === 'watch' || route.query.broadcast === '1');
const spectatorQuery = computed(() => {
  if (route.name !== 'watch') return '';
  return `?share=${encodeURIComponent(String(route.params.share))}`;
});
const view = computed<PublicGame | undefined>(() => {
  const replay = replaySession.value;
  if (!replay) return state.value;
  const history = replay.game.history.slice(0, replayIndex.value);
  const frame = history.at(-1)?.after ?? gameFrame(toRaw(replay.initial));
  const used = new Set(
    history.filter((entry) => entry.seat === replaySeat.value)
      .flatMap((entry) => entry.move?.cards.map((card) => card.id) ?? []),
  );
  const { hands, ...game } = replay.game;
  return {
    ...game,
    ...frame,
    history,
    study: replay.study,
    viewpointSeat: replaySeat.value,
    visibleHand: replay.initial.hands[replaySeat.value].filter((card) => !used.has(card.id)),
    agents: replay.agents,
    thinking: null,
    delayMs: 1800,
    autoNext: false,
    nextRoundAt: null,
  };
});
const status = computed(() => ({
  ready: '等待开始',
  running: view.value?.thinking !== null ? 'AI 思考中' : '正在对局',
  paused: '对局暂停',
  'round-over': '本局结束',
  'match-over': '比赛结束',
}[view.value?.status ?? 'ready']));
const replaying = computed(() => !!replaySession.value);
const replayLength = computed(() => replaySession.value?.game.history.length ?? 0);
let spokenGame = '';
let spokenSeq = -1;
let stream: EventSource | undefined;
let clock: ReturnType<typeof setInterval> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function notify(text: string) {
  notice.value = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ''), 5000);
}
async function enableBroadcastAudio() {
  if (speechReady.value) {
    stopTableVoice();
    speechReady.value = false;
    audioError.value = '';
    return;
  }
  try {
    const voiceSupported = await enableTableAudio();
    speechReady.value = true;
    audioError.value = voiceSupported ? '' : '当前浏览器不支持语音合成，仅播放牌型音效';
  } catch {
    audioError.value = '声音初始化失败，请检查浏览器音频设置。';
    notify(audioError.value);
  }
}
function queueTableAudio(game: PublicGame) {
  const entry = game.history.at(-1);
  if (spokenGame !== game.id) {
    spokenGame = game.id;
    spokenSeq = entry?.seq ?? -1;
    return;
  }
  if (!entry || entry.seq <= spokenSeq) return;
  spokenSeq = entry.seq;
  if (!speechReady.value || replaying.value) return;
  const effect = entry.seat < 0
    ? entry.after?.tributeKind === 'anti' ? 'tribute-anti' : 'tribute'
    : entry.move?.kind ?? 'play';
  playTableEffect(effect);
  const text = tableVoiceText(entry);
  if (text) speakTableLine(text, entry.seat);
}
function applyState(next: PublicGame) {
  state.value = next;
  queueTableAudio(next);
}
async function action(name: string) {
  if (replaying.value) return;
  pending.value = true;
  try {
    const response = await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: name }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '对局操作失败');
    applyState(data);
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : '对局操作失败');
  } finally {
    pending.value = false;
  }
}
async function shareMatch() {
  const url = `${location.origin}${sharePath.value}`;
  try {
    if (navigator.share) await navigator.share({ title: 'AI/4 · 实时博弈实验', url });
    else {
      await navigator.clipboard.writeText(url);
      notify('直播链接已复制');
    }
  } catch {
    notify('分享未完成，请从直播工作台复制链接');
  }
}
async function leave() {
  if (!replaying.value) await action('pause');
  replaySession.value = undefined;
  await router.push('/studio');
}
async function exitReplay() {
  replaySession.value = undefined;
  replayIndex.value = 0;
  await loadLiveState();
}
function openStream() {
  stream?.close();
  stream = new EventSource('/api/events' + spectatorQuery.value);
  stream.onmessage = (event) => {
    now.value = Date.now();
    try {
      applyState(JSON.parse(event.data));
      connected.value = true;
    } catch {
      notify('牌桌数据解析失败，正在等待下一次同步');
    }
  };
  stream.onerror = () => (connected.value = false);
}
async function loadLiveState() {
  try {
    const response = await fetch('/api/state' + spectatorQuery.value);
    if (!response.ok) {
      viewerError.value = broadcastMode.value
        ? '直播链接已失效，请向管理员获取新的观战地址。'
        : '管理员会话已过期，请重新登录。';
      if (!broadcastMode.value) await router.replace('/login');
      return;
    }
    applyState(await response.json());
    openStream();
  } catch {
    viewerError.value = '暂时无法连接牌桌，请刷新页面重试。';
  }
}
onMounted(async () => {
  clock = setInterval(() => (now.value = Date.now()), 1000);
  if (replaying.value) connected.value = true;
  else await loadLiveState();
});
onBeforeUnmount(() => {
  stream?.close();
  if (clock) clearInterval(clock);
  clearTimeout(noticeTimer);
  stopTableVoice();
});
</script>

<template>
  <MobileBroadcast
    v-if="view"
    :game="view"
    :now="now"
    :connected="connected || replaying"
    :status="status"
    :speech-ready="speechReady"
    :audio-error="audioError"
    :mode="broadcastMode ? 'watch' : 'console'"
    :pending="pending"
    :replay="replaying"
    :replay-index="replayIndex"
    :replay-length="replayLength"
    :notice="notice"
    @enable-audio="enableBroadcastAudio"
    @orientation-notice="notify"
    @control="action($event)"
    @share="shareMatch"
    @back="leave"
    @replay-seek="replayIndex = $event"
    @replay-exit="exitReplay"
  />
  <div v-else class="mobile-broadcast-loading">
    <strong>AI/4 · 博弈实验桌</strong>
    <span>{{ viewerError }}</span>
  </div>
</template>

<style scoped>
.mobile-broadcast-loading {
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 8px;
  min-height: 100dvh;
  padding: 24px;
  background: #eeeee7;
  color: #627168;
  text-align: center;
}
.mobile-broadcast-loading strong { color: #203c32; font-size: 17px; }
</style>
