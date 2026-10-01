import 'dotenv/config';
import express from 'express';
import { localNarration } from './narration.js';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { defaults, decide, heuristic } from './agents.js';
import { applyMove, legalMoves, newGame, nextRound } from './rules.js';
import { publicState, safeAgent } from './public-state.js';
import { createAccess } from './access.js';
import {
  gameFrame,
  type AgentConfig,
  type Game,
  type Move,
  type PublicGame,
} from '../shared/types.js';
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
await mkdir('data/replays', { recursive: true });
const access = await createAccess();
let delayMs = 1800,
  autoNext = true;
let narration: {
  engine: 'browser' | 'api';
  baseUrl: string;
  model: string;
  voice: string;
  apiKey?: string;
} = { engine: 'browser', baseUrl: 'https://model.rhzy.ai/v1', model: 'tts-1', voice: 'alloy' };
let agents: AgentConfig[] = structuredClone(defaults);
try {
  const saved = access.decrypt(JSON.parse(await readFile('data/agents.json', 'utf8')));
  agents = Array.isArray(saved) ? saved : saved.agents;
  if (!Array.isArray(agents) || agents.length !== 4) agents = structuredClone(defaults);
  if (!Array.isArray(saved)) {
    delayMs = saved.delayMs ?? 1800;
    autoNext = saved.autoNext ?? true;
    if (saved.narration) narration = saved.narration;
  }
} catch (error: any) {
  if (error.code !== 'ENOENT') throw Error('模型配置读取失败，请检查管理员数据与配置备份是否配套');
}
let game = newGame(),
  thinking: number | null = null,
  busy = false,
  epoch = 0;
let nextRoundAt: number | null = null;
let roundInitial = structuredClone(game),
  roundOffset = 0;
function replayData() {
  return {
    version: 1,
    rules: 'arena-v2',
    agents: agents.map(safeAgent),
    initial: roundInitial,
    game: { ...game, history: game.history.slice(roundOffset) },
  };
}
function rememberRound() {
  roundInitial = structuredClone(game);
  roundInitial.history = [];
  roundOffset = game.history.length;
}
const clients = new Set<express.Response>();
let presentation = { speech: false, showFeed: false };
function snapshot(): PublicGame {
  return {
    ...publicState(game, agents, { thinking, delayMs, autoNext, nextRoundAt }),
    presentation,
    narration: {
      engine: 'api',
      ready: true,
    },
  };
}
function broadcast() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const c of clients) c.write(data);
}
const Decision = Annotation.Root({
  game: Annotation<Game>(),
  config: Annotation<AgentConfig>(),
  moves: Annotation<Move[]>(),
  move: Annotation<Move>(),
  source: Annotation<string>(),
  reason: Annotation<string>(),
  error: Annotation<string>(),
});
const graph = new StateGraph(Decision)
  .addNode('observe', (s) => ({
    moves: legalMoves(s.game.hands[s.game.turn], s.game.level, s.game.last),
  }))
  .addNode('decide', async (s) => {
    try {
      return await decide(s.config, s.game, s.moves);
    } catch {
      return {
        move: heuristic(s.game, s.moves),
        source: '本地兜底',
        reason: '外部模型调用未成功，使用本地合法策略',
        error: '模型调用失败（网络、凭证、超时或结果格式）。请使用连接测试诊断。',
      };
    }
  })
  .addNode('validate', (s) => {
    if (!s.moves.some((m) => m.id === s.move.id)) throw Error('非法模型动作');
    return {};
  })
  .addEdge(START, 'observe')
  .addEdge('observe', 'decide')
  .addEdge('decide', 'validate')
  .addEdge('validate', END)
  .compile();
async function archive() {
  const replay = replayData();
  const path = `data/replays/${game.id}-${game.round}.json`;
  await writeFile(path + '.tmp', JSON.stringify(replay, null, 2));
  await rename(path + '.tmp', path);
}
async function step() {
  if (busy) throw Error('正在决策中');
  if (['round-over', 'match-over'].includes(game.status)) throw Error('本局已结束');
  busy = true;
  thinking = game.turn;
  broadcast();
  const generation = epoch,
    start = Date.now(),
    seat = game.turn;
  try {
    const result = await graph.invoke({ game: structuredClone(game), config: agents[seat] });
    if (generation !== epoch) return;
    const wasRunning = game.status === 'running';
    const move = applyMove(game, result.move.id);
    if (game.status === 'round-over' && autoNext && wasRunning) nextRoundAt = Date.now() + 8000;
    game.history.push({
      seq: game.history.length + 1,
      seat,
      text: move.label + '。' + result.reason,
      move,
      source: result.source,
      elapsedMs: Date.now() - start,
      time: new Date().toISOString(),
      after: gameFrame(game),
      ...(result.error ? { error: result.error } : {}),
    });
    if (['round-over', 'match-over'].includes(game.status)) await archive();
  } finally {
    if (generation === epoch) {
      busy = false;
      thinking = null;
      broadcast();
    }
  }
}
let timer: ReturnType<typeof setTimeout> | undefined;
function schedule() {
  clearTimeout(timer);
  const generation = epoch;
  timer = setTimeout(
    async () => {
      if (generation !== epoch) return;
      try {
        if (game.status === 'running') await step();
        if (generation !== epoch) return;
        if (
          autoNext &&
          game.status === 'round-over' &&
          nextRoundAt !== null &&
          Date.now() >= nextRoundAt
        ) {
          nextRoundAt = null;
          nextRound(game);
          rememberRound();
          game.status = 'running';
          broadcast();
        }
      } catch (e) {
        if (generation === epoch) {
          game.status = 'paused';
          console.error('对局暂停:', e instanceof Error ? e.message : '未知错误');
          broadcast();
        }
      } finally {
        if (generation === epoch) schedule();
      }
    },
    game.status === 'round-over' && nextRoundAt !== null ? 250 : delayMs,
  );
}
schedule();
app.get('/api/health', (_q, r) => r.json({ ok: true, version: '0.1.0' }));
app.use('/api', (q, r, next) => {
  if (!['GET', 'HEAD'].includes(q.method) && q.headers.origin) {
    try {
      const origin = new URL(q.headers.origin);
      const localDevelopment =
        ['127.0.0.1', 'localhost'].includes(q.hostname) &&
        ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin.origin);
      if (origin.host !== q.headers.host && !localDevelopment) {
        r.status(403).json({ error: '来源不允许' });
        return;
      }
    } catch {
      r.sendStatus(403);
      return;
    }
  }
  next();
});
app.post('/api/auth/login', access.login);
app.post('/api/auth/logout', access.logout);
app.get('/api/auth/session', (q, r) =>
  r.json(access.session(q) ? { authenticated: true, ...access.info } : { authenticated: false }),
);
app.use(['/api/state', '/api/events'], (q, r, next) => {
  if (!access.viewer(q)) {
    r.status(401).json({ error: '请登录或使用管理员分享的观战链接' });
    return;
  }
  next();
});
const audioCache = new Map<string, Buffer>();
const audioRequests = new Map<string, Promise<Buffer>>();
let audioVersion = 0;
app.get('/api/narration', async (q, r) => {
  if (!access.viewer(q)) {
    r.sendStatus(401);
    return;
  }
  const seq = Number(q.query.seq),
    entry = game.history.find((e) => e.seq === seq);
  const welcome = q.query.welcome === '1';
  if (!welcome && (!entry || seq < game.history.length - 12 || entry.seat < 0 || q.query.game !== game.id)) {
    r.status(404).json({ error: '解说已过期' });
    return;
  }
  const id = welcome ? `${audioVersion}:welcome` : `${audioVersion}:${game.id}:${seq}`;
  const text = welcome ? '欢迎来到掼蛋 AI 俱乐部，解说声音已开启' : `${agents[entry!.seat].name}，${entry!.move?.label ?? '不出'}`;
  try {
    let audio = audioCache.get(id);
    if (!audio) {
      let pending = audioRequests.get(id);
      if (!pending) {
        pending = (async () => {
          let generated: Buffer;
          if (narration.engine === 'api' && narration.apiKey) {
            try {
              const response = await fetch(narration.baseUrl.replace(/\/$/, '') + '/audio/speech', {
                method: 'POST',
                headers: { Authorization: `Bearer ${narration.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: narration.model, voice: narration.voice, input: text, response_format: 'mp3' }),
                signal: AbortSignal.timeout(8000),
              });
              if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/')) throw Error('voice service failed');
              generated = Buffer.from(await response.arrayBuffer());
              if (generated.length < 1 || generated.length > 2000000) throw Error('invalid audio');
            } catch { generated = await localNarration(text); }
          } else { generated = await localNarration(text); }
          if (audioCache.size >= 24) audioCache.delete(audioCache.keys().next().value!);
          audioCache.set(id, generated);
          return generated;
        })();
        audioRequests.set(id, pending);
      }
      try {
        audio = await pending;
      } finally {
        audioRequests.delete(id);
      }
    }
    r.set('Cache-Control', 'private, max-age=60').type(audio.toString('ascii', 0, 4) === 'RIFF' ? 'audio/wav' : 'audio/mpeg').send(audio);
  } catch {
    r.status(502).json({ error: '音频生成失败，请管理员检查服务器中文语音依赖' });
  }
});
app.get('/api/state', (_q, r) => r.json(snapshot()));
app.get('/api/events', (q, r) => {
  r.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  r.flushHeaders();
  clients.add(r);
  r.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  const heartbeat = setInterval(() => r.write(': heartbeat\n\n'), 15000);
  q.on('close', () => {
    clients.delete(r);
    clearInterval(heartbeat);
  });
});
app.use('/api', (q, r, next) => {
  if (!access.session(q)) {
    r.status(401).json({ error: '请先登录管理员账户' });
    return;
  }
  const origin = q.headers.origin;
  if (origin) {
    try {
      const hostname = new URL(origin).hostname;
      if (!['localhost', '127.0.0.1', q.hostname].includes(hostname)) {
        r.status(403).json({ error: '来源不允许' });
        return;
      }
    } catch {
      r.sendStatus(403);
      return;
    }
  }
  next();
});
app.post('/api/control', async (q, r) => {
  try {
    if (q.body.action === 'presentation') {
      const settings = z
        .object({ speech: z.boolean().optional(), showFeed: z.boolean().optional() })
        .strict()
        .parse(q.body.presentation);
      presentation = { ...presentation, ...settings };
      broadcast();
      r.json(snapshot());
      return;
    }
    const { action } = z
      .object({ action: z.enum(['start', 'pause', 'step', 'reset', 'restart', 'next']) })
      .parse(q.body);
    if (action === 'pause') {
      game.status = game.status === 'running' ? 'paused' : game.status;
      nextRoundAt = null;
      epoch++;
      busy = false;
      thinking = null;
    } else if (action === 'restart') {
      epoch++;
      game = newGame();
      nextRoundAt = null;
      thinking = null;
      busy = false;
      rememberRound();
      game.status = 'running';
    } else {
      if (busy) throw Error('请等待当前决策完成');
      if (action === 'start') {
        if (game.status === 'match-over') throw Error('比赛结束，请重新比赛');
        if (game.status === 'round-over') {
          nextRound(game);
          rememberRound();
        }
        nextRoundAt = null;
        game.status = 'running';
      }
      if (action === 'reset') {
        epoch++;
        game = newGame();
        nextRoundAt = null;
        rememberRound();
      }
      if (action === 'next') {
        nextRoundAt = null;
        nextRound(game);
        rememberRound();
      }
      if (action === 'step') {
        if (game.status === 'running') throw Error('请先暂停再单步');
        game.status = game.status === 'ready' ? 'paused' : game.status;
        await step();
      }
    }
    broadcast();
    schedule();
    r.json(snapshot());
  } catch (e) {
    r.status(400).json({ error: e instanceof Error ? e.message : '操作失败' });
  }
});
const configSchema = z
  .object({
    name: z.string().min(1).max(24),
    provider: z.enum(['builtin', 'openai']),
    baseUrl: z.string().max(500),
    model: z.string().max(100),
    keyEnv: z.string().regex(/^$|^[A-Z][A-Z0-9_]*$/),
    apiKey: z.string().max(2000).optional(),
    deleteKey: z.boolean().optional(),
    keyConfigured: z.boolean().optional(),
    personality: z.string().max(300),
    jev: z
      .object({
        enabled: z.boolean(),
        baseUrl: z
          .string()
          .url()
          .refine((v) => {
            const u = new URL(v);
            return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
          }),
        keyEnv: z.string().regex(/^$|^[A-Z][A-Z0-9_]*$/),
        apiKey: z.string().max(2000).optional(),
        deleteKey: z.boolean().optional(),
        keyConfigured: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine((v, c) => {
    if (v.provider !== 'builtin') {
      try {
        const u = new URL(v.baseUrl);
        if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
          c.addIssue({ code: 'custom', message: '接口必须是 HTTP(S) 地址且不能包含密码' });
      } catch {
        c.addIssue({ code: 'custom', message: '无效接口 URL' });
      }
      if (!v.keyEnv && !v.apiKey && !v.keyConfigured && !v.deleteKey)
        c.addIssue({ code: 'custom', message: '请填写模型 API Key' });
      if (v.provider === 'openai' && !v.model)
        c.addIssue({ code: 'custom', message: '请填写模型名称' });
    }
  });
app.get('/api/config', (_q, r) =>
  r.json({
    agents: agents.map(safeAgent),
    delayMs,
    autoNext,
    narration: { ...narration, apiKey: undefined, keyConfigured: Boolean(narration.apiKey) },
  }),
);
function mergeKeys(config: AgentConfig, old?: AgentConfig): AgentConfig {
  const { deleteKey, keyConfigured, ...value } = config;
  const jev = config.jev;
  return {
    ...value,
    keyEnv: deleteKey ? '' : value.keyEnv,
    apiKey: deleteKey ? undefined : value.apiKey?.trim() || old?.apiKey,
    ...(jev
      ? {
          jev: {
            enabled: jev.enabled,
            baseUrl: jev.baseUrl,
            keyEnv: jev.deleteKey ? '' : jev.keyEnv,
            apiKey: jev.deleteKey ? undefined : jev.apiKey?.trim() || old?.jev?.apiKey,
          },
        }
      : {}),
  };
}
app.put('/api/config', async (q, r) => {
  try {
    if (busy || game.status === 'running') throw Error('请先暂停并等待决策完成');
    const body = z
      .object({
        agents: z.array(configSchema).length(4),
        delayMs: z.number().int().min(300).max(30000),
        autoNext: z.boolean(),
        narration: z
          .object({
            engine: z.enum(['browser', 'api']),
            baseUrl: z
              .string()
              .url()
              .refine(
                (v) =>
                  ['http:', 'https:'].includes(new URL(v).protocol) &&
                  !new URL(v).username &&
                  !new URL(v).password,
              ),
            model: z.string().min(1).max(100),
            voice: z.string().min(1).max(100),
            apiKey: z.string().max(2000).optional(),
            deleteKey: z.boolean().optional(),
            keyConfigured: z.boolean().optional(),
          })
          .optional(),
      })
      .parse(q.body);
    const updated = body.agents.map((config, i) => mergeKeys(config, agents[i]));
    const updatedNarration = body.narration
      ? {
          engine: body.narration.engine,
          baseUrl: body.narration.baseUrl,
          model: body.narration.model,
          voice: body.narration.voice,
          apiKey: body.narration.deleteKey
            ? undefined
            : body.narration.apiKey?.trim() || narration.apiKey,
        }
      : narration;
    await writeFile(
      'data/agents.json.tmp',
      JSON.stringify(
        access.encrypt({
          agents: updated,
          delayMs: body.delayMs,
          autoNext: body.autoNext,
          narration: updatedNarration,
        }),
      ),
      { mode: 0o600 },
    );
    await rename('data/agents.json.tmp', 'data/agents.json');
    agents = updated;
    delayMs = body.delayMs;
    autoNext = body.autoNext;
    if (!autoNext) nextRoundAt = null;
    narration = updatedNarration;
    audioCache.clear();
    audioVersion++;
    broadcast();
    r.json({ ok: true });
  } catch (e) {
    r.status(400).json({ error: e instanceof Error ? e.message : '配置错误' });
  }
});
app.post('/api/test', async (q, r) => {
  try {
    const { seat, ...body } = q.body;
    const config = mergeKeys(
      configSchema.parse(body),
      Number.isInteger(seat) && seat >= 0 && seat < 4 ? agents[seat] : undefined,
    );
    const testGame = newGame();
    const moves = legalMoves(testGame.hands[0], testGame.level, null);
    const start = Date.now();
    const result = await decide(config, testGame, moves);
    r.json({
      ok: true,
      source: result.source,
      move: result.move.label,
      elapsedMs: Date.now() - start,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : '连接失败';
    r.status(400).json({
      error:
        message.startsWith('服务端环境变量') ||
        message.startsWith('模型 HTTP') ||
        message.startsWith('模型没有')
          ? message
          : '连接测试失败：请检查接口、Key、模型名称和返回结构。',
    });
  }
});
app.get('/api/inspect', (_q, r) => r.json({ ...snapshot(), hands: game.hands }));
app.get('/api/replay', (_q, r) => r.attachment(`guandan-${game.id}.json`).json(replayData()));
app.use(express.static(resolve('dist')));
app.get('/{*path}', (_q, r) => r.sendFile(resolve('dist/index.html')));
app.use((err: Error, _q: express.Request, r: express.Response, _next: express.NextFunction) =>
  r.status(400).json({ error: err.message }),
);
const host = process.env.HOST ?? '127.0.0.1',
  port = Number(process.env.PORT ?? 3001);
app.listen(port, host, () => console.log(`掼蛋 AI 服务 http://${host}:${port}`));
