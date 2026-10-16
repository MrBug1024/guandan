<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { analyzeRound, type RoundAnalytics } from '../shared/analytics';
import { DEFAULT_STUDY, rankName, type AgentConfig, type Entry, type Game, type StudyProtocol } from '../shared/types';
import { replaySession } from './replay';
import UiIcon from './UiIcon.vue';
import './history-analysis.css';

interface ReplayRow extends RoundAnalytics {
  file: string;
  gameId: string;
  round: number;
  level: number;
  status: Game['status'];
  winner: number | null;
  finished: number[];
  players: Array<{ name: string; provider: AgentConfig['provider']; model: string }>;
  study?: StudyProtocol;
  completedAt: string | null;
}
interface ReplayArchive {
  version: number;
  rules: string;
  initial: Game;
  game: Game;
  agents: AgentConfig[];
  study?: StudyProtocol;
}

const router = useRouter();
const rows = ref<ReplayRow[]>([]);
const selected = ref<ReplayRow>();
const archive = ref<ReplayArchive>();
const selectedSeq = ref<number | null>(null);
const selectedTopic = ref('all');
const loading = ref(false);
const error = ref('');
const selectedMetrics = computed(() => archive.value
  ? analyzeRound(archive.value.initial, archive.value.game, archive.value.agents)
  : undefined);
function protocolKey(study?: StudyProtocol) {
  if (!study) return 'legacy:unrecorded';
  return JSON.stringify([study.title, study.question, study.hypothesis, study.measure]);
}
const topics = computed(() => {
  const unique = new Map<string, string>();
  for (const row of rows.value) {
    const key = protocolKey(row.study);
    const label = row.study ? `${row.study.title} · ${row.study.question}` : '未记录课题';
    if (!unique.has(key)) unique.set(key, label);
  }
  return [...unique].map(([key, label]) => ({ key, label }));
});
const filteredRows = computed(() => selectedTopic.value === 'all'
  ? rows.value
  : rows.value.filter((row) => protocolKey(row.study) === selectedTopic.value));
const totals = computed(() => {
  const decisions = filteredRows.value.reduce((sum, row) => sum + row.decisionCount, 0);
  const modelDecisions = filteredRows.value.reduce((sum, row) => sum + row.successfulModelDecisions, 0);
  const modelRequests = filteredRows.value.reduce((sum, row) => sum + row.externalModelRequests, 0);
  const fallbacks = filteredRows.value.reduce((sum, row) => sum + row.fallbacks, 0);
  const weightedLatency = filteredRows.value.reduce((sum, row) => sum + row.averageLatencyMs * row.decisionCount, 0);
  const partnerEvents = filteredRows.value.flatMap((row) => row.partnerLeadEvents);
  const partnerChoices = partnerEvents.filter((event) => event.opportunity === 'available');
  return {
    rounds: filteredRows.value.length,
    decisions,
    modelDecisions,
    modelRequests,
    fallbacks,
    averageLatency: decisions ? Math.round(weightedLatency / decisions) : 0,
    partnerSamples: partnerChoices.length,
    passCount: partnerChoices.filter((event) => event.action === 'pass').length,
    continueCount: partnerChoices.filter((event) => event.action === 'play-over-partner').length,
    forcedPasses: partnerEvents.filter((event) => event.opportunity === 'forced' && event.action === 'pass').length,
    unknownPasses: partnerEvents.filter((event) => event.opportunity === 'unknown' && event.action === 'pass').length,
  };
});
const selectedStudy = computed(() => archive.value?.study ?? selected.value?.study ?? DEFAULT_STUDY);
const selectedEvent = computed(() => archive.value?.game.history.find((entry) => entry.seq === selectedSeq.value));
const partnerEvent = computed(() => selectedMetrics.value?.partnerLeadEvents.find((event) => event.seq === selectedEvent.value?.seq));
const decisionEntries = computed(() => archive.value?.game.history.filter((entry) => entry.seat >= 0 && entry.move) ?? []);
const candidateList = computed(() => selectedEvent.value?.decision?.candidates ?? []);
const resultText = computed(() => {
  if (!selected.value) return '';
  if (selected.value.winner === null) return '归档时尚未结束';
  return `队伍 ${selected.value.winner === 0 ? 'A' : 'B'} 获胜`;
});
function formatDate(value: string | null) {
  if (!value) return '时间未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未记录' : date.toLocaleString('zh-CN', { hour12: false });
}
async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const response = await fetch('/api/replays');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '历史归档读取失败');
    rows.value = data;
    if (selected.value) {
      const updated = rows.value.find((row) => row.file === selected.value!.file);
      if (updated) await openReplay(updated);
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '历史归档读取失败';
  } finally {
    loading.value = false;
  }
}
async function openReplay(row: ReplayRow) {
  selected.value = row;
  error.value = '';
  try {
    const response = await fetch('/api/replays/' + encodeURIComponent(row.file));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '回放读取失败');
    archive.value = data;
    selectedSeq.value = data.game.history.filter((entry: Entry) => entry.seat >= 0 && entry.move).at(-1)?.seq ?? null;
  } catch (cause) {
    archive.value = undefined;
    error.value = cause instanceof Error ? cause.message : '回放读取失败';
  }
}
async function playReplay() {
  if (!archive.value) return;
  replaySession.value = {
    game: archive.value.game,
    initial: archive.value.initial,
    agents: archive.value.agents,
    study: archive.value.study,
  };
  await router.push('/arena');
}
function downloadReplay() {
  if (!archive.value || !selected.value) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(archive.value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = selected.value.file;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
onMounted(refresh);
</script>

<template>
  <section class="archive-research">
    <header class="archive-heading"><div class="archive-brand"><span>AI/4</span><div><small>THE DECISION ROOM / ARCHIVE</small><h2>历史课题与决策复盘</h2></div></div><button class="archive-refresh" :disabled="loading" @click="refresh"><UiIcon name="refresh" />{{ loading ? '读取中' : '刷新归档' }}</button></header>
    <p v-if="error" class="archive-error" role="status">{{ error }}</p>

    <section class="archive-question"><div><small>课题筛选</small><h3>{{ selectedTopic === 'all' ? '所有归档课题' : topics.find((topic) => topic.key === selectedTopic)?.label ?? '选定课题' }}</h3></div><select v-model="selectedTopic" aria-label="按课题筛选"><option value="all">全部课题</option><option v-for="topic in topics" :key="topic.key" :value="topic.key">{{ topic.label }}</option></select></section>

    <div class="archive-overview">
      <div><small>归档牌局</small><strong>{{ totals.rounds }}</strong></div>
      <div><small>已记录决策</small><strong>{{ totals.decisions }}</strong></div>
      <div><small>模型成功 / HTTP 请求</small><strong>{{ totals.modelDecisions }} / {{ totals.modelRequests }}</strong></div>
      <div><small>可选搭档响应</small><strong>{{ totals.partnerSamples }}</strong></div>
      <div><small>可选时主动让牌</small><strong>{{ totals.passCount }}<i> / {{ totals.partnerSamples }}</i></strong></div>
      <div><small>本地兜底</small><strong>{{ totals.fallbacks }}</strong></div>
    </div>
    <p class="archive-method">可选响应只计确认存在合法出牌选择的情境；强制要不起 {{ totals.forcedPasses }} 次，旧归档无法判断 {{ totals.unknownPasses }} 次。所有计数均为行为观察，不是协作得分；不同提示词与牌局条件未做因果比较。</p>

    <section class="archive-list">
      <header><h3>归档记录</h3><span>{{ filteredRows.length }} 局 · 最多显示 200 份</span></header>
      <div class="archive-table-wrap"><table><thead><tr><th>完成时间</th><th>课题 / 研究问题</th><th>局数 / 结果</th><th>决策</th><th>主动让牌 / 可选</th><th>兜底</th><th></th></tr></thead><tbody>
        <tr v-for="row in filteredRows" :key="row.file" :class="{ selected: selected?.file === row.file }"><td>{{ formatDate(row.completedAt) }}</td><td class="archive-topic-cell"><strong>{{ row.study?.title ?? '未记录课题' }}</strong><small>{{ row.study?.question ?? '该归档没有课题快照。' }}</small></td><td>{{ row.round }} · {{ row.winner === null ? '未结束' : '队伍 ' + (row.winner === 0 ? 'A' : 'B') }}</td><td>{{ row.decisionCount }}</td><td>{{ row.partnerLeadEvents.filter((event) => event.opportunity === 'available' && event.action === 'pass').length }} / {{ row.partnerLeadEvents.filter((event) => event.opportunity === 'available').length }}<small> · {{ row.partnerLeadEvents.filter((event) => event.opportunity === 'forced' && event.action === 'pass').length }} 次强制</small></td><td>{{ row.fallbacks }}</td><td><button class="archive-open" @click="openReplay(row)">{{ selected?.file === row.file ? '查看中' : '复盘' }}</button></td></tr>
        <tr v-if="!filteredRows.length"><td colspan="7" class="archive-empty">{{ loading ? '正在读取归档…' : '当前筛选下没有归档。' }}</td></tr>
      </tbody></table></div>
    </section>

    <section v-if="selected && archive && selectedMetrics" class="archive-detail">
      <header class="archive-detail-heading"><div><small>{{ formatDate(selected.completedAt) }} · {{ resultText }}</small><h3>{{ selectedStudy.title }}</h3><p>{{ selectedStudy.question }}</p></div><div class="archive-actions"><button class="archive-secondary" @click="downloadReplay">导出 JSON</button><button class="archive-primary" @click="playReplay">进入逐步回放</button></div></header>
      <div class="archive-protocol"><div><small>工作假设</small><p>{{ selectedStudy.hypothesis }}</p></div><div><small>观察口径</small><p>{{ selectedStudy.measure }}</p></div></div>
      <div class="archive-result-strip"><div><small>模型成功决策</small><strong>{{ selectedMetrics.successfulModelDecisions }}</strong></div><div><small>模型 HTTP 请求</small><strong>{{ selectedMetrics.externalModelRequests }}</strong></div><div><small>可选搭档响应</small><strong>n={{ selectedMetrics.partnerLeadEvents.filter((event) => event.opportunity === 'available').length }}</strong></div><div><small>可选时主动让牌</small><strong>{{ selectedMetrics.partnerLeadEvents.filter((event) => event.opportunity === 'available' && event.action === 'pass').length }}</strong></div><div><small>强制 / 未知过牌</small><strong>{{ selectedMetrics.partnerLeadEvents.filter((event) => event.opportunity === 'forced' && event.action === 'pass').length }} / {{ selectedMetrics.partnerLeadEvents.filter((event) => event.opportunity === 'unknown' && event.action === 'pass').length }}</strong></div><div><small>决策中位耗时</small><strong>{{ (selectedMetrics.medianLatencyMs / 1000).toFixed(2) }}s</strong></div><div><small>P95 / 兜底</small><strong>{{ (selectedMetrics.p95LatencyMs / 1000).toFixed(2) }}s · {{ selectedMetrics.fallbacks }}</strong></div></div>

      <div class="archive-review-grid">
        <section class="event-timeline"><header><div><small>EVENT LOG</small><h4>逐步决策</h4></div><span>{{ decisionEntries.length }} 条</span></header><div class="event-list"><button v-for="entry in decisionEntries" :key="entry.seq" :class="{ active: selectedSeq === entry.seq, context: selectedMetrics.partnerLeadEvents.some((event) => event.seq === entry.seq) }" @click="selectedSeq = entry.seq"><span>#{{ String(entry.seq).padStart(3, '0') }}</span><div><strong>{{ archive.agents[entry.seat]?.name }} · {{ entry.move?.label ?? entry.text }}</strong><small>{{ entry.source }} · {{ entry.elapsedMs }}ms · {{ selectedMetrics.partnerLeadEvents.some((event) => event.seq === entry.seq) ? '搭档领出情境' : '常规决策' }}</small></div><i></i></button><p v-if="!decisionEntries.length" class="archive-empty-inline">此归档没有可复盘的决策事件。</p></div></section>

        <section v-if="selectedEvent" class="event-inspector"><header><div><small>DECISION TRACE / #{{ selectedEvent.seq }}</small><h4>{{ archive.agents[selectedEvent.seat]?.name }} · {{ selectedEvent.move?.label }}</h4></div><span>{{ selectedEvent.elapsedMs }} ms</span></header><div v-if="partnerEvent" class="event-context"><b>搭档领出情境 · {{ partnerEvent.opportunity === 'available' ? '可选动作' : partnerEvent.opportunity === 'forced' ? '强制过牌' : '旧记录未知' }}</b><span>{{ archive.agents[partnerEvent.partnerSeat]?.name }} 先领出，本席{{ partnerEvent.action === 'pass' ? '选择让牌' : '选择接管牌权' }}。</span></div><div class="event-notes"><div><small>决策说明</small><p>{{ selectedEvent.decision?.rationale ?? selectedEvent.text }}</p></div><div><small>战术读局 · 公开假设</small><p>{{ selectedEvent.decision?.tacticalRead ?? '本次没有记录模型战术推测。' }}</p></div></div><div class="archive-candidate-title"><strong>实际候选记录</strong><span>{{ selectedEvent.decision?.candidateSource === 'model-shortlist' ? '模型输入候选集' : selectedEvent.decision?.candidateSource === 'legal-action-set' ? '规则引擎合法动作集' : selectedEvent.decision?.candidateSource ?? '旧归档未保存' }} · {{ selectedEvent.decision?.candidateCount ?? 0 }} 项 · 合法动作 {{ selectedEvent.decision?.legalActionCount ?? '未采集' }}</span></div><ol v-if="candidateList.length" class="archive-candidates"><li v-for="candidate in candidateList" :key="candidate.moveId" :class="{ chosen: candidate.moveId === selectedEvent.decision?.selectedMoveId }"><span>{{ String(candidate.index + 1).padStart(2, '0') }}</span><strong>{{ candidate.label }}</strong><small>{{ candidate.cardCount }} 张</small><b v-if="candidate.moveId === selectedEvent.decision?.selectedMoveId">已选</b></li></ol><div v-else class="archive-no-candidates">{{ selectedEvent.decision?.candidateSource === 'legal-action-set' ? '本地启发式在合法动作集中按固定规则评分；系统未保存单独排序。' : '该条记录没有候选牌面，不能事后补造模型选项。' }}</div><p v-if="selectedEvent.error" class="archive-fallback">兜底说明：{{ selectedEvent.error }}</p></section>
        <section v-else class="event-inspector archive-empty-inline">选择左侧事件查看决策记录。</section>
      </div>
      <div class="archive-analytics-grid"><section><header><h4>响应时间分布</h4><span>系统延迟，不表示决策质量</span></header><div class="latency-bars"><div v-for="agent in selectedMetrics.agents" :key="agent.seat"><span>{{ agent.name }}</span><i><em :style="{ width: Math.min(100, agent.medianLatencyMs / Math.max(1, selectedMetrics.p95LatencyMs) * 100) + '%' }"></em></i><b>{{ (agent.medianLatencyMs / 1000).toFixed(2) }}s</b></div></div></section><section><header><h4>席位结果</h4><span>{{ resultText }}</span></header><div class="finish-order"><span v-for="(seat, index) in selected.finished" :key="seat"><b>{{ index + 1 }}</b>{{ archive.agents[seat]?.name }}</span><small v-if="!selected.finished.length">尚无完赛顺序</small></div></section></div>
    </section>
  </section>
</template>
