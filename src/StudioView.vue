<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, toRaw, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { replaySession } from './replay';
import { admin, sharePath } from './auth';
import ViewPicker from './ViewPicker.vue';
import UiIcon from './UiIcon.vue';
import ExperimentDashboard from './ExperimentDashboard.vue';
import HistoryAnalysis from './HistoryAnalysis.vue';
const router = useRouter(),
  route = useRoute();
const panel = computed(() => String(route.name ?? 'lobby'));
import type { PublicGame, AgentConfig } from '../shared/types';
const state = ref<PublicGame>(),
  connected = ref(false),
  toast = ref(''),
  pending = ref(false),
  draft = ref<AgentConfig[]>([]),
  speed = ref(1800),
  autoNext = ref(true),
  replay = replaySession;
async function setViewpoint(value: string) {
  try {
    await api('control', 'POST', {
      action: 'presentation',
      presentation:
        value === 'third'
          ? { cameraMode: 'third' }
          : { viewpointSeat: Number(value), cameraMode: 'first' },
    });
    notify(value === 'third' ? '已切换全桌第三视角' : '第一视角已切换');
  } catch (e) {
    notify((e as Error).message);
  }
}
async function logout() {
  await api('auth/logout');
  admin.value = false;
  await router.replace('/login');
}
const cameraChoice = computed(() =>
  state.value?.presentation?.cameraMode === 'third'
    ? 'third'
    : String(state.value?.viewpointSeat ?? 0),
);
const icons = ['✿', '◈', '●', '✦'],
  colors = ['#f5adbd', '#a9bbff', '#a8d6bf', '#ffd19a'];
let stream: EventSource, clearToast: ReturnType<typeof setTimeout>;
function notify(text: string) {
  toast.value = text;
  clearTimeout(clearToast);
  clearToast = setTimeout(() => (toast.value = ''), 5500);
}
async function api(path: string, method = 'POST', body?: unknown) {
  const r = await fetch('/api/' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await r.json();
  if (r.status === 401) {
    admin.value = false;
    await router.replace('/login');
  }
  if (!r.ok) {
    const error = Error(json.error ?? '请求失败');
    Object.assign(error, { providerRequestCount: json.providerRequestCount });
    throw error;
  }
  return json;
}
async function control(action: string) {
  if (replay.value) {
    notify('请先退出回放');
    return;
  }
  pending.value = true;
  try {
    await api('control', 'POST', { action });
  } catch (e) {
    notify((e as Error).message);
  } finally {
    pending.value = false;
  }
}
async function fillDraft() {
  draft.value = structuredClone(toRaw(state.value?.agents ?? []));
  speed.value = state.value?.delayMs ?? 1800;
  autoNext.value = state.value?.autoNext ?? true;
  try {
    const config = await api('config', 'GET');
    draft.value = config.agents;
  } catch (error) {
    notify((error as Error).message);
  }
}
function openConfig() {
  fillDraft();
  router.push('/studio/models');
}
watch(
  () => route.name,
  (name) => {
    if (name === 'config') fillDraft();
  },
);
async function save(enter = false) {
  pending.value = true;
  try {
    await api('config', 'PUT', {
      agents: draft.value,
      delayMs: speed.value,
      autoNext: autoNext.value,
    });
    notify('模型配置已保存');
    if (enter) await startArena();
    else router.push('/studio');
  } catch (e) {
    notify((e as Error).message);
  } finally {
    pending.value = false;
  }
}
async function test(i: number) {
  pending.value = true;
  try {
    const result = await api('test', 'POST', { ...draft.value[i], seat: i });
    const calls = result.providerRequestCount
      ? `真实模型 API 请求 ${result.providerRequestCount} 次`
      : '本次未调用外部模型';
    notify(`${calls} · ${result.source} · ${result.elapsedMs}ms · ${result.move}`);
  } catch (e) {
    const error = e as Error & { providerRequestCount?: number };
    if (error.providerRequestCount !== undefined)
      notify(`${error.message} · 实际模型 API 请求 ${error.providerRequestCount} 次`);
    else notify(error.message);
  } finally {
    pending.value = false;
  }
}

async function startArena() {
  pending.value = true;
  try {
    replaySession.value = undefined;
    if (state.value?.status === 'match-over') await api('control', 'POST', { action: 'reset' });
    if (state.value?.status !== 'running') await api('control', 'POST', { action: 'start' });
    await router.push('/arena');
  } catch (e) {
    notify((e as Error).message);
  } finally {
    pending.value = false;
  }
}

function changeProvider(a: AgentConfig) {
  if (a.provider === 'openai') {
    a.baseUrl = 'https://model.rhzy.ai/v1';
    a.model = '';
    a.keyEnv = 'OPENAI_API_KEY';
  }
}
function enableJev(a: AgentConfig, event: Event) {
  a.jev = {
    ...a.jev,
    enabled: (event.target as HTMLInputElement).checked,
    baseUrl: a.jev?.baseUrl ?? 'http://10.0.10.2:8019/mcp',
    keyEnv: a.jev?.keyEnv ?? 'JEV_API_KEY',
  };
}
const liveUrl = computed(
  () => `${location.origin}${sharePath.value}`,
);
onMounted(() => {
  stream = new EventSource('/api/events');
  stream.onmessage = (e) => {
    try {
      state.value = JSON.parse(e.data);
      connected.value = true;
      if (panel.value === 'config' && !draft.value.length) fillDraft();
    } catch {
      notify('对局数据读取失败');
    }
  };
  stream.onerror = () => (connected.value = false);
});
onBeforeUnmount(() => {
  stream?.close();
  clearTimeout(clearToast);
});
</script>
<template>
  <div class="app">
    <aside class="sidebar">
      <a class="brand" href="/studio"
        >4<span>AI/4<span class="brand-ai">LAB</span></span></a
      >
      <div class="workspace-label">AI 博弈实验中控</div>
      <button @click="logout"><UiIcon name="exit" /> <span>退出登录</span></button>
      <button :class="{ selected: panel === 'lobby' }" @click="router.push('/studio')">
        <UiIcon name="home" /> <span>实验总览</span><small>01</small></button
      ><button :class="{ selected: route.name === 'arena' }" @click="router.push('/arena')">
        <UiIcon name="live" /> <span>牌桌控制台</span><small>02</small></button
      ><button :class="{ selected: panel === 'config' }" @click="openConfig">
        <UiIcon name="models" /> <span>实验配置</span><small>03</small></button
      ><button :class="{ selected: panel === 'live' }" @click="router.push('/studio/broadcast')">
        <UiIcon name="live" /> <span>直播输出</span><small>04</small></button
      ><button :class="{ selected: panel === 'history' }" @click="router.push('/studio/history')">
        <UiIcon name="analytics" /> <span>历史复盘</span><small>05</small></button>
      <div class="sidebar-bottom">
        <div class="local-mark">AI/4 · FIELD STUDY</div>
        <p>让每次博弈都成为可复核的决策实验。</p>
        <span :class="['connection', connected ? 'online' : '']">{{
          connected ? '裁判服务已连接' : '正在连接裁判服务…'
        }}</span>
      </div>
    </aside>
    <main>
      <header v-if="panel !== 'lobby' && panel !== 'history'">
        <div>
          <span class="eyebrow">GUANDAN / AI ARENA</span>
          <h1>
            {{
              panel === 'config'
                ? '选手与模型'
                : panel === 'live'
                  ? '直播工作台'
                  : '实时实验总览'
            }}
          </h1>
        </div>
        <div class="header-right">
          <span class="pill">{{
            replay ? '回放模式' : connected ? '● 实时对局' : '○ 服务离线'
          }}</span
          ><button class="avatar" @click="openConfig" aria-label="模型设置">
            <UiIcon name="settings" />
          </button>
        </div>
      </header>
      <ExperimentDashboard v-if="panel === 'lobby' && state" :game="state" :connected="connected" @control="control" />
      <HistoryAnalysis v-else-if="panel === 'history'" />
      <section v-else-if="panel === 'config'" class="settings">
        <div class="section-intro">
          <h2>四个座位，四种个性。</h2>
          <p>每位选手独立决策。API Key 由管理员管理，保存后不会回显；留空保留已有 Key。内置策略不请求外部模型，只有成功返回的模型决策会计入模型对局。</p>
        </div>
        <div class="config-grid">
          <article v-for="(a, i) in draft" :key="i" class="config-card">
            <h3 :style="{ color: colors[i] }">
              {{ icons[i] }} 选手 0{{ i + 1 }} <small>搭档 0{{ ((i + 2) % 4) + 1 }}</small>
            </h3>
            <label>角色名称<input v-model="a.name" maxlength="24" /></label
            ><label
              >决策来源<select v-model="a.provider" @change="changeProvider(a)">
                <option value="builtin">内置策略 · 零 API 成本</option>
                <option value="openai">OpenAI 兼容接口</option>
              </select></label
            ><template v-if="a.provider !== 'builtin'"
              ><label
                >Base URL（含 /v1）<input
                  v-model="a.baseUrl"
                  placeholder="https://api.example.com/v1" /></label
              ><label>Model<input v-model="a.model" placeholder="填写服务商实际模型 ID" /></label
              ><label
                >服务端 Key 环境变量<input
                  v-model="a.keyEnv"
                  maxlength="64"
                  placeholder="MINIMAX_API_KEY"
                  autocomplete="off" /></label
              ><label
                >模型 API Key<input
                  type="password"
                  v-model="a.apiKey"
                  :placeholder="a.keyConfigured ? '已配置 · 留空保留' : '可留空并使用上方环境变量'"
                  autocomplete="off" /></label></template
            ><template v-if="a.provider === 'openai'">
              <label class="check"
                ><input type="checkbox" :checked="a.jev?.enabled" @change="enableJev(a, $event)" />
                允许选手调用 JEV 辅助决策</label
              >
              <template v-if="a.jev?.enabled"
                ><label>JEV MCP URL<input v-model="a.jev.baseUrl" /></label
                ><label
                  >JEV API Key<input
                    type="password"
                    v-model="a.jev.apiKey"
                    :placeholder="a.jev.keyConfigured ? '已配置 · 留空保留' : '输入 JEV API Key'"
                    autocomplete="off"
                /></label>
                <label class="check"
                  ><input type="checkbox" v-model="a.jev.deleteKey" /> 保存时删除 JEV Key</label
                >
              </template> </template
            ><label class="check" v-if="a.provider === 'openai'"
              ><input type="checkbox" v-model="a.deleteKey" /> 保存时删除模型 Key</label
            ><label
              >角色个性<textarea v-model="a.personality" rows="2" maxlength="300"></textarea></label
            ><button class="ghost full" :disabled="pending" @click="test(i)">
              测试连接与决策 ↗
            </button>
          </article>
        </div>
        <div class="settings-bottom">
          <ViewPicker :agents="state?.agents ?? []" :value="cameraChoice" @change="setViewpoint" />
          <p class="subtle">
            直播页声音由观众本机控制，使用牌桌短句、牌型音效与少量模型战术读局，不调用语音服务。
          </p>
          <label
            >行动间隔<select v-model.number="speed">
              <option :value="600">0.6 秒 · 快速测试</option>
              <option :value="1800">1.8 秒 · 标准</option>
              <option :value="3500">3.5 秒 · 直播</option>
              <option :value="6000">6 秒 · 慢速观察</option>
            </select></label
          ><label class="check"><input type="checkbox" v-model="autoNext" /> 自动进入下一局</label
          ><button class="primary" :disabled="pending" @click="save(false)">保存配置</button
          ><button class="primary" :disabled="pending" @click="save(true)">保存并开始对局 →</button>
        </div>
        <div class="config-running" v-if="state?.status === 'running' || state?.nextRoundAt">
          <span>对局正在进行，修改配置前请暂停。</span
          ><button class="ghost" :disabled="pending" @click="control('pause')">暂停当前对局</button>
        </div>
        <p class="subtle">
          保存前请暂停对局。外部模型每次决策最多选择 41 个合法候选，每次接口请求限时 45
          秒，工具咨询会增加决策时间，失败后明确兜底。连接测试会真实调用一次模型。
        </p>
      </section>
      <section v-else-if="panel === 'live'" class="settings">
        <div class="section-intro">
          <span class="eyebrow">PUBLIC RESEARCH FEED</span>
          <h2>让观众跟着问题看决策。</h2>
          <p>公开页呈现实验命题、当下选择、模型返回的战术推测与行为样本，不包含管理控制。</p>
        </div>
        <div class="live-preview">
          <span class="live-tag">BROADCAST OUTPUT</span>
          <h3>AI 博弈实验直播</h3>
          <p>决策过程 · 搭档博弈 · 情境观察</p>
          <a class="primary" :href="liveUrl" target="_blank">打开直播画面 ↗</a>
        </div>
        <div class="live-grid">
          <article>
            <h3>01 / 添加画面</h3>
            <p>
              OBS 新建「浏览器」来源，填写下方 URL。版式会按窗口方向适配；竖屏推流建议 1080 × 1920，横屏移动端建议 1920 × 1080。
            </p>
            <input readonly :value="liveUrl" aria-label="直播画面地址" />
          </article>
          <article>
            <h3>02 / 选择平台</h3>
            <p>
              抖音、快手使用官方直播伴侣捕获浏览器／OBS
              画面；视频号使用官方直播工具。获得平台推流地址时，也可配置 OBS 自定义 RTMP。
            </p>
            <div class="platforms">
              <a href="https://streamingtool.douyin.com/" target="_blank">抖音 ↗</a
              ><a href="https://live.kuaishou.com/live-partner" target="_blank">快手 ↗</a
              ><a href="https://channels.weixin.qq.com/" target="_blank">视频号 ↗</a>
            </div>
          </article>
          <article>
            <h3>03 / 观察席与牌桌声音</h3>
            <ViewPicker
              :agents="state?.agents ?? []"
              :value="cameraChoice"
              @change="setViewpoint"
            />
            <p>
              观众可在牌桌页自行开启或关闭短喊声与特殊牌型音效。复杂局势的战术推测只在有真实模型输出时播报。
            </p>
          </article>
        </div>
        <p class="subtle">
          此页面准备直播素材；实际开播需要平台账号直播权限及官方工具。同播多个平台需各自授权与编码能力。
        </p>
      </section>
      <div v-else class="loading">
        正在连接本地裁判服务…
        <p>请使用 npm run dev 同时启动前后端。</p>
      </div>
      <div class="bottom-note">
        <span>✧ 规则引擎裁判 · 合法动作校验 · 模型独立决策</span><span>GUANDAN ARENA / v0.1</span>
      </div>
    </main>
    <div v-if="toast" role="status" class="toast">{{ toast }}</div>
  </div>
</template>
