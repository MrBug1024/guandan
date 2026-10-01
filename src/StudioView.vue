<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, toRaw, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { replaySession } from './replay';
import { admin, sharePath } from './auth';
const router = useRouter(),
  route = useRoute();
const panel = computed(() => String(route.name ?? 'lobby'));
import { cardName, rankName, type PublicGame, type AgentConfig } from '../shared/types';
const portrait = new URLSearchParams(location.search).get('layout') === 'portrait';
const state = ref<PublicGame>(),
  connected = ref(false),
  toast = ref(''),
  pending = ref(false),
  draft = ref<AgentConfig[]>([]),
  speed = ref(1800),
  autoNext = ref(true),
  inspection = ref<PublicGame>(),
  replay = replaySession,
  speech = ref(false);
async function setSpeech(event: Event) {
  await api('control', 'POST', {
    action: 'presentation',
    presentation: { speech: (event.target as HTMLInputElement).checked },
  });
}
async function logout() {
  await api('auth/logout');
  admin.value = false;
  await router.replace('/login');
}
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
  if (!r.ok) throw Error(json.error ?? '请求失败');
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
    if (name === 'inspect') inspect();
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
    notify(`连接成功 · ${result.source} · ${result.elapsedMs}ms · ${result.move}`);
  } catch (e) {
    notify((e as Error).message);
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
async function inspect() {
  try {
    inspection.value = await api('inspect', 'GET');
    router.push('/studio/replays');
  } catch (e) {
    notify((e as Error).message);
  }
}
async function download() {
  try {
    const data = await api('replay', 'GET');
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `guandan-${data.game.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    notify((e as Error).message);
  }
}
async function loadReplay(event: Event) {
  const input = event.target as HTMLInputElement;
  try {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 10e6) throw Error('回放不能超过10MB');
    const data = JSON.parse(await file.text());
    if (
      data.version !== 1 ||
      !data.initial?.hands ||
      !Array.isArray(data.game?.history) ||
      data.agents?.length !== 4
    )
      throw Error('回放格式不正确');
    replay.value = data;
    router.push('/arena');
  } catch (e) {
    notify((e as Error).message);
  }
  input.value = '';
}
const liveUrl = computed(
  () => `${location.origin}${sharePath.value}${portrait ? '?layout=portrait' : ''}`,
);
onMounted(() => {
  stream = new EventSource('/api/events');
  stream.onmessage = (e) => {
    try {
      state.value = JSON.parse(e.data);
      connected.value = true;
      speech.value = state.value?.presentation?.speech ?? false;
      if (panel.value === 'config' && !draft.value.length) fillDraft();
      if (panel.value === 'inspect' && !inspection.value) inspect();
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
        >g<span>掼蛋<span class="brand-ai">AI</span></span></a
      >
      <div class="workspace-label">竞技工作室</div>
      <button @click="logout">↗ <span>退出登录</span></button>
      <button :class="{ selected: panel === 'lobby' }" @click="router.push('/studio')">
        ◉ <span>赛事大厅</span><small>01</small></button
      ><button :class="{ selected: panel === 'config' }" @click="openConfig">
        ◇ <span>模型配置</span><small>02</small></button
      ><button :class="{ selected: panel === 'live' }" @click="router.push('/studio/broadcast')">
        ▣ <span>直播工作台</span><small>03</small></button
      ><button :class="{ selected: panel === 'inspect' }" @click="inspect">
        ▤ <span>手牌与回放</span><small>04</small>
      </button>
      <div class="sidebar-bottom">
        <div class="local-mark">✦ LOCAL FIRST</div>
        <p>四个模型，一场默契的较量。</p>
        <span :class="['connection', connected ? 'online' : '']">{{
          connected ? '裁判服务已连接' : '正在连接裁判服务…'
        }}</span>
      </div>
    </aside>
    <main>
      <header>
        <div>
          <span class="eyebrow">GUANDAN / AI ARENA</span>
          <h1>
            {{
              panel === 'config'
                ? '选手与模型'
                : panel === 'live'
                  ? '直播工作台'
                  : panel === 'inspect'
                    ? '对局实验室'
                    : '赛事工作室'
            }}
          </h1>
        </div>
        <div class="header-right">
          <span class="pill">{{
            replay ? '回放模式' : connected ? '● 实时对局' : '○ 服务离线'
          }}</span
          ><button class="avatar" @click="openConfig" aria-label="模型设置">⚙</button>
        </div>
      </header>
      <section v-if="panel === 'lobby' && state" class="studio-lobby">
        <div class="lobby-hero">
          <span class="eyebrow">YOUR NEXT GAME STARTS HERE</span>
          <h2>准备好，围桌而坐。</h2>
          <p>
            配置四位 AI 选手，然后进入独立的全屏牌局。<br />从桃桃的肩后观战，感受每一次默契的出牌。
          </p>
          <div>
            <button class="primary" :disabled="pending || !connected" @click="startArena">
              {{ state.status === 'running' ? '进入正在进行的对局 →' : '开始对局 →' }}</button
            ><button class="ghost" @click="openConfig">配置选手与节奏</button>
          </div>
        </div>
        <div class="lobby-seats">
          <article v-for="(a, i) in state.agents" :key="i" :style="{ '--seat-color': colors[i] }">
            <span>{{ icons[i] }}</span>
            <h3>{{ a.name }}</h3>
            <p>
              {{ ['近侧 · 观战手牌可见', '左侧 · 手牌隐藏', '对面 · 搭档', '右侧 · 手牌隐藏'][i] }}
            </p>
            <small>{{ a.provider === 'builtin' ? '内置策略' : a.model }}</small>
          </article>
        </div>
        <div class="lobby-info">
          <span>第 {{ state.round }} 局 · 打 {{ rankName(state.level) }}</span
          ><span>{{ state.autoNext ? '连续对局 · 局间停留 8 秒' : '单局模式' }}</span
          ><RouterLink to="/arena">只进入观战画面 ↗</RouterLink>
          <button :disabled="pending" @click="control('restart')">重新开始比赛</button>
        </div>
      </section>
      <section v-else-if="panel === 'config'" class="settings">
        <div class="section-intro">
          <h2>四个座位，四种个性。</h2>
          <p>每位选手独立决策。API Key 由管理员管理，保存后不会回显；留空保留已有 Key。</p>
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
                >模型 API Key<input
                  type="password"
                  v-model="a.apiKey"
                  :placeholder="a.keyConfigured ? '已配置 · 留空保留' : '输入模型 API Key'"
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
                ></template
              > </template
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
          <p class="subtle">解说统一通过音频播放，观众点击开启声音即可。使用自然普通话音色，无需另配 Key。</p>
          <label
            >行动间隔<select v-model.number="speed">
              <option :value="600">0.6 秒 · 快速测试</option>
              <option :value="1800">1.8 秒 · 标准</option>
              <option :value="3500">3.5 秒 · 直播</option>
              <option :value="6000">6 秒 · 解说</option>
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
          <span class="eyebrow">READY FOR YOUR AUDIENCE</span>
          <h2>把这场较量，带到直播间。</h2>
          <p>独立直播画面共用同一场对局，隐藏所有控制与凭证配置。</p>
        </div>
        <div class="live-preview">
          <span class="live-tag">BROADCAST OUTPUT</span>
          <h3>掼蛋 AI 竞技场</h3>
          <p>4 个 AI · 2 支队伍 · 无限默契</p>
          <a class="primary" :href="liveUrl" target="_blank">打开直播画面 ↗</a>
        </div>
        <div class="live-grid">
          <article>
            <h3>01 / 添加画面</h3>
            <p>
              OBS 新建「浏览器」来源，填写下方 URL，推荐 1920 × 1080、30 FPS。竖屏用 URL 增加
              ?layout=portrait，设为 1080 × 1920。
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
            <h3>03 / 解说与节奏</h3>
            <p>
              控制页保持静音，解说开关同步到观众页。观众首次点击开启声音；微信建议使用模型配置中的音频服务解说。
            </p>
            <label class="check"
              ><input type="checkbox" :checked="speech" @change="setSpeech" /> 直播页语音解说</label
            >
          </article>
        </div>
        <p class="subtle">
          此页面准备直播素材；实际开播需要平台账号直播权限及官方工具。同播多个平台需各自授权与编码能力。
        </p>
      </section>
      <section v-else-if="panel === 'inspect'" class="settings">
        <div class="section-intro">
          <h2>看清每一步决策。</h2>
          <p>此处可调试四家手牌。对局观众只看到近侧选手的手牌，另外三家保持隐藏。</p>
        </div>
        <div class="inspect-actions">
          <button class="primary" @click="inspect">刷新手牌</button
          ><button class="ghost" @click="download">导出完整回放 ↓</button
          ><label class="file-button"
            >导入回放<input type="file" accept="application/json" @change="loadReplay"
          /></label>
        </div>
        <div class="hand-grid">
          <article v-for="(hand, i) in inspection?.hands" :key="i">
            <h3 :style="{ color: colors[i] }">
              {{ inspection?.agents[i].name }} · {{ hand.length }} 张
            </h3>
            <div class="cards">
              <span
                v-for="c in hand"
                :key="c.id"
                :class="{ red: c.suit === 'H' || c.suit === 'D' }"
                >{{ cardName(c) }}</span
              >
            </div>
          </article>
        </div>
        <p class="subtle">
          完整回放包含全部手牌，适合赛后分析。回放时间轴按本文件中的历史事件展示，不会调用模型。
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
