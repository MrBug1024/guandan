<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { analyzeRound } from '../shared/analytics';
import { DEFAULT_STUDY, rankName, type DecisionTrace, type Entry, type PublicGame, type StudyProtocol } from '../shared/types';
import UiIcon from './UiIcon.vue';
import './experiment.css';

const props = defineProps<{ game: PublicGame; connected: boolean }>();
const emit = defineEmits<{ control: [action: 'start' | 'pause' | 'step' | 'restart'] }>();
interface DecisionRow extends Pick<Entry, 'seq' | 'seat' | 'source' | 'elapsedMs' | 'time' | 'move' | 'error' | 'text'> {
  decision?: DecisionTrace;
}
const privateDecisions = computed(() => new Map(
  adminLog.value.map((entry) => [entry.seq, entry.decision] as const),
));
const analyticsGame = computed(() => ({
  ...props.game,
  history: props.game.history.map((entry) => {
    const decision = privateDecisions.value.get(entry.seq);
    return decision ? { ...entry, decision } : entry;
  }),
}));
const metrics = computed(() => analyzeRound(
  { last: null, lastSeat: 0 }, analyticsGame.value, props.game.agents,
));
const study = computed(() => props.game.study ?? DEFAULT_STUDY);
const rows = computed(() => props.game.history.filter(
  (entry) => !entry.after || entry.after.round === props.game.round,
));
const decisions = computed(() => rows.value.filter((entry) => entry.seat >= 0 && entry.move));
const adminLog = ref<DecisionRow[]>([]);
const selectedSeq = ref<number | null>(null);
const logError = ref('');
const studyDraft = ref<StudyProtocol>({ ...DEFAULT_STUDY });
const savingStudy = ref(false);
const studyMessage = ref('');
let logRequest = 0;

watch(study, (value) => { studyDraft.value = { ...value }; }, { immediate: true });
watch(
  () => [props.game.id, props.game.round, props.game.history.length],
  () => void refreshDecisions(),
  { immediate: true },
);
watch(() => decisions.value.at(-1)?.seq, (seq) => {
  if (seq !== undefined && (selectedSeq.value === null || !decisions.value.some((entry) => entry.seq === selectedSeq.value)))
    selectedSeq.value = seq;
}, { immediate: true });
onBeforeUnmount(() => { logRequest++; });

async function refreshDecisions() {
  const request = ++logRequest;
  logError.value = '';
  try {
    const response = await fetch('/api/decisions');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '决策记录读取失败');
    if (request === logRequest && data.gameId === props.game.id && data.round === props.game.round)
      adminLog.value = data.entries;
  } catch (cause) {
    if (request === logRequest) logError.value = cause instanceof Error ? cause.message : '决策记录读取失败';
  }
}
async function saveStudy() {
  savingStudy.value = true;
  studyMessage.value = '';
  try {
    const response = await fetch('/api/study', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(studyDraft.value),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '课题保存失败');
    studyDraft.value = { ...data.study };
    studyMessage.value = '课题已保存';
  } catch (cause) {
    studyMessage.value = cause instanceof Error ? cause.message : '课题保存失败';
  } finally {
    savingStudy.value = false;
  }
}
function actionLabel(entry?: DecisionRow | PublicGame['history'][number]) {
  return entry?.move?.label ?? entry?.text ?? '等待动作';
}
function sourceLabel(entry?: DecisionRow | PublicGame['history'][number]) {
  if (!entry) return '尚无决策';
  const method = 'decision' in entry ? entry.decision?.method : undefined;
  return method === 'model' ? '外部模型'
    : method === 'heuristic' ? '本地启发式'
      : method === 'fallback' ? '本地兜底'
        : method === 'forced' ? '规则强制' : entry.source;
}

const selectedEvent = computed(() => decisions.value.find((entry) => entry.seq === selectedSeq.value));
const selectedTrace = computed(() => adminLog.value.find((entry) => entry.seq === selectedSeq.value));
const selectedDecision = computed<DecisionTrace | undefined>(() => selectedTrace.value?.decision);
const timeline = computed(() => rows.value.slice(-10).reverse());
const partnerEvents = computed(() => metrics.value.partnerLeadEvents);
const partnerChoices = computed(() => partnerEvents.value.filter((event) => event.opportunity === 'available'));
const partnerPasses = computed(() => partnerChoices.value.filter((event) => event.action === 'pass').length);
const partnerPresses = computed(() => partnerChoices.value.filter((event) => event.action === 'play-over-partner').length);
const forcedPartnerPasses = computed(() => partnerEvents.value.filter(
  (event) => event.opportunity === 'forced' && event.action === 'pass',
).length);
const unknownPartnerPasses = computed(() => partnerEvents.value.filter(
  (event) => event.opportunity === 'unknown' && event.action === 'pass',
).length);
const activeDecisionCount = computed(() => decisions.value.length);
const modelSeatCount = computed(() => props.game.agents.filter((agent) => agent.provider === 'openai').length);
const readyModelSeatCount = computed(() => props.game.agents.filter(
  (agent) => agent.provider === 'openai' && agent.keyConfigured,
).length);
const successfulModelDecisions = computed(() => adminLog.value.filter(
  (entry) => entry.decision?.method === 'model',
).length);
const externalModelRequests = computed(() => adminLog.value.reduce(
  (total, entry) => total + (entry.decision?.providerRequestCount ?? 0),
  0,
));
const canEditStudy = computed(() => props.game.status !== 'running' &&
  (activeDecisionCount.value === 0 || ['round-over', 'match-over'].includes(props.game.status)));
const stateLabel = computed(() => ({
  ready: '待启动', running: '正在采集', paused: '已暂停', 'round-over': '本局结束', 'match-over': '比赛结束',
}[props.game.status]));
const latencyBars = computed(() => {
  const values = metrics.value.latencyTimeline.slice(-28);
  const max = Math.max(1, ...values.map((row) => row.elapsedMs));
  return values.map((row) => ({ ...row, height: Math.max(4, row.elapsedMs / max * 42) }));
});
</script>

<template>
  <section class="research-dashboard">
    <header class="console-heading">
      <div class="console-title"><span>AI/4</span><div><small>THE DECISION ROOM · RESEARCH CONSOLE</small><h1>实时实验总览</h1></div></div>
      <div class="console-actions">
        <span class="connection-state" :class="{ connected }"><i></i>{{ connected ? '数据实时同步' : '正在重连' }}</span>
        <button class="action-button" :disabled="props.game.thinking !== null || props.game.status === 'running'" @click="emit('control', 'step')">单步决策</button>
        <button class="action-primary" :disabled="props.game.status === 'match-over'" @click="emit('control', props.game.status === 'running' ? 'pause' : 'start')">{{ props.game.status === 'running' ? '暂停对局' : '开始 / 继续' }}</button>
        <RouterLink to="/arena" class="open-table">进入牌桌控制台 <UiIcon name="live" :size="14" /></RouterLink>
      </div>
    </header>

    <section class="protocol-bar">
      <div class="protocol-state"><span>本局课题</span><b>{{ study.title }}</b><i :class="{ active: game.status === 'running' }"></i>{{ stateLabel }} · 第 {{ String(game.round).padStart(2, '0') }} 局</div>
      <h2>{{ study.question }}</h2>
      <div class="protocol-meta"><span><b>工作假设</b>{{ study.hypothesis }}</span><span><b>观察口径</b>{{ study.measure }}</span></div>
      <details class="protocol-editor">
        <summary :aria-disabled="!canEditStudy" @click="!canEditStudy && $event.preventDefault()">编辑课题</summary>
        <form @submit.prevent="saveStudy">
          <label>课题名称<input v-model="studyDraft.title" maxlength="60" :disabled="!canEditStudy" /></label>
          <label>研究问题<input v-model="studyDraft.question" maxlength="180" :disabled="!canEditStudy" /></label>
          <label>工作假设<textarea v-model="studyDraft.hypothesis" maxlength="240" rows="2" :disabled="!canEditStudy"></textarea></label>
          <label>观察口径<textarea v-model="studyDraft.measure" maxlength="240" rows="2" :disabled="!canEditStudy"></textarea></label>
          <div class="protocol-save"><small>{{ studyMessage || (canEditStudy ? '保存后同步到直播与新归档。' : '请在一局结束后修改。') }}</small><button type="submit" :disabled="savingStudy || !canEditStudy">保存课题</button></div>
        </form>
      </details>
    </section>

    <section class="model-runtime" :class="{ ready: readyModelSeatCount > 0 }" aria-label="模型运行状态">
      <strong>{{ readyModelSeatCount }}/4 外部模型席位已配置凭据</strong>
      <span v-if="!modelSeatCount">当前 4 个席位均使用内置策略；本局不会请求外部 AI 模型。</span>
      <span v-else-if="!readyModelSeatCount">已选择 {{ modelSeatCount }} 个外部模型席位，但凭据未就绪；不会产生模型请求。</span>
      <span v-else>请求数只统计实际发出的模型 HTTP 请求；成功决策只统计模型有效返回，不含本地规则与兜底。</span>
      <RouterLink to="/studio/models">配置席位</RouterLink>
    </section>

    <section class="metric-strip" aria-label="本局实时指标">
      <div><small>已完成决策</small><strong>{{ activeDecisionCount }}</strong><span>含规则强制动作</span></div>
      <div><small>模型成功决策</small><strong>{{ successfulModelDecisions }}</strong><span>真实有效模型返回</span></div>
      <div><small>模型 HTTP 请求</small><strong>{{ externalModelRequests }}</strong><span>包括重试与失败请求</span></div>
      <div><small>可选协作样本</small><strong>{{ partnerChoices.length }}</strong><span>确认存在合法出牌选择</span></div>
      <div><small>决策中位耗时</small><strong>{{ (metrics.medianLatencyMs / 1000).toFixed(2) }}<i> s</i></strong><span>P95 {{ (metrics.p95LatencyMs / 1000).toFixed(2) }} s</span></div>
      <div><small>异常兜底</small><strong :class="{ alert: metrics.fallbacks > 0 }">{{ metrics.fallbacks }}</strong><span>系统稳定性信号</span></div>
    </section>

    <div class="console-grid">
      <section class="timeline-panel">
        <header class="panel-heading"><div><small>ROUND {{ String(game.round).padStart(2, '0') }} · EVENT STREAM</small><h2>最近行动</h2></div><span>最新 {{ timeline.length }} 条</span></header>
        <ol class="decision-timeline">
          <li v-for="entry in timeline" :key="entry.seq" :class="{ selected: selectedSeq === entry.seq, referee: entry.seat < 0 }">
            <button @click="entry.seat >= 0 && entry.move && (selectedSeq = entry.seq)">
              <span class="event-seat">{{ entry.seat < 0 ? '裁判' : '0' + (entry.seat + 1) }}</span>
              <span class="event-description"><strong>{{ entry.seat < 0 ? entry.text : game.agents[entry.seat]?.name + ' · ' + actionLabel(entry) }}</strong><small>{{ entry.seat < 0 ? '规则事件' : sourceLabel(adminLog.find((row) => row.seq === entry.seq) ?? entry) }} · {{ entry.elapsedMs }} ms{{ entry.error ? ' · 已兜底' : '' }}</small></span>
              <time>{{ new Date(entry.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}</time>
            </button>
          </li>
          <li v-if="!timeline.length" class="timeline-empty">开始对局后，动作、让牌与规则事件会按发生顺序记录在这里。</li>
        </ol>
        <div class="timeline-footer"><span>等待动作席</span><strong v-if="game.thinking !== null">{{ game.agents[game.thinking]?.name }} 正在决策</strong><strong v-else>{{ game.status === 'running' ? game.agents[game.turn]?.name + ' 即将行动' : stateLabel }}</strong><span>剩余 {{ game.counts.join(' / ') }} 张</span></div>
      </section>

      <section class="decision-panel">
        <header class="panel-heading"><div><small>DECISION TRACE · {{ selectedEvent ? '#' + String(selectedEvent.seq).padStart(3, '0') : 'NO EVENT' }}</small><h2>决策拆解</h2></div><span>{{ sourceLabel(selectedTrace ?? selectedEvent) }}</span></header>
        <template v-if="selectedEvent">
          <div class="decision-result"><small>{{ game.agents[selectedEvent.seat]?.name }} · {{ selectedEvent.elapsedMs }} ms</small><strong>{{ actionLabel(selectedEvent) }}</strong></div>
          <div class="decision-note"><small>模型公开说明</small><p>{{ selectedTrace?.decision?.rationale ?? selectedEvent.decision?.rationale ?? selectedEvent.text }}</p></div>
          <div class="decision-note tactical-note"><small>战术读局 / 对手意图假设</small><p>{{ selectedTrace?.decision?.tacticalRead ?? selectedEvent.decision?.tacticalRead ?? '该动作没有返回战术推测。不要把页面补充文案当作模型输出。' }}</p></div>
          <div class="candidate-head"><strong>候选与选择</strong><span>{{ selectedDecision?.candidateSource === 'model-shortlist' ? '模型输入候选集' : selectedDecision?.candidateSource === 'legal-action-set' ? '启发式合法动作集' : selectedDecision?.candidateSource === 'forced' ? '仅一个合法动作' : '没有候选牌面记录' }} · {{ selectedDecision?.candidateCount ?? 0 }}<i> · 合法动作 {{ selectedDecision?.legalActionCount ?? '旧记录未采集' }}</i></span></div>
          <ol v-if="selectedDecision?.candidates?.length" class="candidate-list"><li v-for="candidate in selectedDecision.candidates" :key="candidate.moveId" :class="{ chosen: candidate.moveId === selectedDecision.selectedMoveId }"><span>{{ String(candidate.index + 1).padStart(2, '0') }}</span><strong>{{ candidate.label }}</strong><small>{{ candidate.cardCount }} 张</small><b v-if="candidate.moveId === selectedDecision.selectedMoveId">已选</b></li></ol>
          <p v-else class="candidate-caveat">{{ selectedDecision?.candidateSource === 'legal-action-set' ? '本地策略对合法动作执行固定启发式；没有独立动作价值评估。' : '此类决策未记录模型可见的候选牌面。' }}</p>
        </template>
        <p v-else class="panel-empty">选择左侧一条行动，查看来源、说明、战术推测与本次候选。</p>
        <p v-if="logError" class="trace-error">管理员决策详情读取失败：{{ logError }}</p>
      </section>
    </div>

    <div class="signal-grid">
      <section class="cooperation-panel">
        <header class="panel-heading"><div><small>TEAM PLAY · AVAILABLE CHOICES</small><h2>队友保有牌权时的可选响应</h2></div><b>n = {{ partnerChoices.length }}</b></header>
        <p class="signal-definition">{{ study.measure }}</p>
        <p class="signal-qualification">只将确认存在合法出牌选择的情境计入图表；强制要不起 {{ forcedPartnerPasses }} 次，旧记录无法判断 {{ unknownPartnerPasses }} 次。</p>
        <div class="cooperation-bars">
          <div><span>主动让牌</span><i><em class="yield" :style="{ width: (partnerChoices.length ? partnerPasses / partnerChoices.length * 100 : 0) + '%' }"></em></i><b>{{ partnerPasses }}</b></div>
          <div><span>接管牌权</span><i><em class="press" :style="{ width: (partnerChoices.length ? partnerPresses / partnerChoices.length * 100 : 0) + '%' }"></em></i><b>{{ partnerPresses }}</b></div>
        </div>
        <div v-if="partnerChoices.length" class="partner-samples"><span v-for="event in partnerChoices.slice(-5).reverse()" :key="event.seq"><b>#{{ event.seq }}</b>{{ game.agents[event.seat]?.name }} · {{ event.action === 'pass' ? '主动让牌' : '接管牌权' }}</span></div>
        <p v-else class="signal-empty">本局尚无确认存在可选动作的事件。计数描述行为，不代表协作质量或最优决策。</p>
      </section>

      <section class="seat-panel">
        <header class="panel-heading"><div><small>LIVE SEATS · SYSTEM SIGNAL</small><h2>选手与响应</h2></div><RouterLink to="/studio/models">模型配置</RouterLink></header>
        <div class="seat-table"><div class="seat-table-head"><span>席位</span><span>模型 / 策略</span><span>剩余</span><span>中位</span></div><div v-for="agent in metrics.agents" :key="agent.seat" class="seat-row"><b :style="{ '--seat-color': ['#e97658', '#258e7b', '#bc9441', '#6874b6'][agent.seat] }">0{{ agent.seat + 1 }} · {{ agent.name }}</b><span>{{ agent.model }}</span><strong>{{ game.counts[agent.seat] }} 张</strong><small :class="{ alert: agent.fallbacks }">{{ (agent.medianLatencyMs / 1000).toFixed(2) }} s <i v-if="agent.fallbacks">· {{ agent.fallbacks }} 次兜底</i></small></div></div>
        <div class="latency-rail"><span>本局响应时间</span><div class="latency-bars"><i v-for="point in latencyBars" :key="point.seq" :style="{ height: point.height + 'px' }" :title="point.elapsedMs + ' ms · #' + point.seq"></i></div><b>{{ metrics.decisionCount }} 次</b></div>
      </section>
    </div>

    <footer class="console-foot"><span>公开理由与战术读局是模型输出，不是内部思维链。</span><RouterLink to="/studio/history">历史对局与跨局统计 <UiIcon name="analytics" :size="14" /></RouterLink></footer>
  </section>
</template>
