import 'dotenv/config';
import express from 'express';
import { naturalNarration, spokenMove } from './narration.js';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { defaults, decide, heuristic } from './agents.js';
import { applyMove, legalMoves, newGame, nextRound } from './rules.js';
import { publicState, safeAgent } from './public-state.js';
import { createAccess } from './access.js';
import { ROUND_CELEBRATION_MS } from '../shared/broadcast-timing.js';
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
    rules: 'arena-v3',
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
const clients = new Map<express.Response, number | undefined>();
let presentation = {
  speech: false,
  showFeed: false,
  viewpointSeat: 0,
  cameraMode: 'first' as 'first' | 'third',
};
function snapshot(viewpointSeat?: number): PublicGame {
  return {
    ...publicState(game, agents, {
      thinking,
      delayMs,
      autoNext,
      nextRoundAt,
      viewpointSeat: viewpointSeat ?? presentation.viewpointSeat,
    }),
    presentation,
    narration: {
      engine: 'api',
      ready: true,
    },
  };
}
function broadcast() {
  if (presentation.speech) {
    const entry = game.history.at(-1);
    void narrationAudio(narrationText(entry)).catch(() => {});
  }
  for (const [client, seat] of clients) client.write(`data: ${JSON.stringify(snapshot(seat))}\n\n`);
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
  if (game.tributeUntil && Date.now() < game.tributeUntil) return;
  if (['round-over', 'match-over'].includes(game.status)) throw Error('本局已结束');
  busy = true;
  thinking = game.turn;
  broadcast();
  const generation = epoch,
    start = Date.now(),
    seat = game.turn;
  // Prepare the common pass call while this player is deciding; no private cards are sent.
  if (presentation.speech && game.last)
    void narrationAudio(spokenMove(agents[seat].name)).catch(() => {});
  try {
    const result = await graph.invoke({ game: structuredClone(game), config: agents[seat] });
    if (generation !== epoch) return;
    const wasRunning = game.status === 'running';
    const move = applyMove(game, result.move.id);
    if (game.status === 'round-over' && autoNext && wasRunning)
      nextRoundAt = Date.now() + ROUND_CELEBRATION_MS;
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
function schedule(previousDecisionMs = 0) {
  clearTimeout(timer);
  const generation = epoch;
  let spentMs = 0;
  timer = setTimeout(
    async () => {
      if (generation !== epoch) return;
      try {
        if (game.status === 'running') {
          const startedAt = Date.now();
          await step();
          spentMs = Date.now() - startedAt;
        }
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
        if (generation === epoch) schedule(spentMs);
      }
    },
    game.status === 'round-over' && nextRoundAt !== null
      ? 250
      : game.status === 'running' && game.tributeUntil && game.tributeUntil > Date.now()
        ? game.tributeUntil - Date.now()
        : Math.max(150, delayMs - previousDecisionMs),
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
const audioStreams = new Map<
  string,
  { chunks: Buffer[]; listeners: Set<(audio: Buffer) => void> }
>();
let audioVersion = 0,
  audioCacheBytes = 0;
function narrationText(entry?: Game['history'][number]) {
  const frame = entry?.after ?? game;
  let text = !entry
    ? '欢迎来到掼蛋人工智能俱乐部，解说声音已开启。'
    : entry.seat < 0
      ? `第${frame.round}局，${frame.tributeKind === 'anti' ? '两张大王，抗贡成功' : frame.tributeKind === 'double' ? '双贡还贡已完成' : '单贡还贡已完成'}。${agents[frame.turn].name}先出牌。`
      : spokenMove(agents[entry.seat].name, entry.move);
  if (entry?.after?.settlement) {
    const result = entry.after.settlement;
    text += result.passedA
      ? '胜方成功打过尖，本场比赛结束。'
      : result.demotedTeam !== undefined
        ? '三次过尖未成功，尝试方降回二。'
        : result.failedA
          ? '本次未能过尖。'
          : `本局结束，头游一方升${result.upgrade}级。`;
  }
  return text;
}
async function narrationAudio(text: string, onChunk?: (audio: Buffer) => void): Promise<Buffer> {
  const id = `${audioVersion}:${text}`;
  const cached = audioCache.get(id);
  if (cached) {
    audioCache.delete(id);
    audioCache.set(id, cached);
    return cached;
  }
  const existing = audioRequests.get(id);
  if (existing) {
    const stream = audioStreams.get(id);
    if (stream && onChunk) {
      for (const chunk of stream.chunks) onChunk(chunk);
      stream.listeners.add(onChunk);
    }
    try {
      return await existing;
    } finally {
      if (onChunk) stream?.listeners.delete(onChunk);
    }
  }
  if (audioRequests.size >= 8) throw Error('解说队列繁忙');
  const stream = { chunks: [] as Buffer[], listeners: new Set<(audio: Buffer) => void>() };
  if (onChunk) stream.listeners.add(onChunk);
  audioStreams.set(id, stream);
  const publish = (chunk: Buffer) => {
    stream.chunks.push(chunk);
    for (const listener of stream.listeners) listener(chunk);
  };
  const pending = (async () => {
    let generated: Buffer;
    if (narration.engine === 'api' && narration.apiKey) {
      try {
        const response = await fetch(narration.baseUrl.replace(/\/$/, '') + '/audio/speech', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${narration.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: narration.model,
            voice: narration.voice,
            input: text,
            response_format: 'mp3',
            speed: 0.92,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/'))
          throw Error('voice service failed');
        generated = Buffer.from(await response.arrayBuffer());
        if (generated.length < 1 || generated.length > 2000000) throw Error('invalid audio');
      } catch {
        generated = await naturalNarration(text, publish);
      }
    } else {
      generated = await naturalNarration(text, publish);
    }
    while (
      audioCache.size &&
      (audioCache.size >= 256 || audioCacheBytes + generated.length > 16 * 1024 * 1024)
    ) {
      const oldest = audioCache.keys().next().value!;
      audioCacheBytes -= audioCache.get(oldest)!.length;
      audioCache.delete(oldest);
    }
    audioCacheBytes += generated.length;
    audioCache.set(id, generated);
    return generated;
  })();
  audioRequests.set(id, pending);
  try {
    return await pending;
  } finally {
    audioRequests.delete(id);
    audioStreams.delete(id);
  }
}
app.get('/api/narration', async (q, r) => {
  if (!access.viewer(q)) {
    r.sendStatus(401);
    return;
  }
  const seq = Number(q.query.seq),
    entry = game.history.find((e) => e.seq === seq);
  const welcome = q.query.welcome === '1';
  if (!welcome && (!entry || seq < game.history.length - 12 || q.query.game !== game.id)) {
    r.status(404).json({ error: '解说已过期' });
    return;
  }
  let streaming = false;
  try {
    const audio = await narrationAudio(narrationText(welcome ? undefined : entry), (chunk) => {
      if (r.destroyed || r.writableEnded) return;
      if (!streaming) {
        r.set({
          'Cache-Control': 'private, max-age=60, no-transform',
          'X-Accel-Buffering': 'no',
        }).type('audio/mpeg');
        streaming = true;
      }
      r.write(chunk);
    });
    if (r.destroyed) return;
    if (streaming) r.end();
    else
      r.set('Cache-Control', 'private, max-age=60')
        .type(audio.toString('ascii', 0, 4) === 'RIFF' ? 'audio/wav' : 'audio/mpeg')
        .send(audio);
  } catch {
    if (r.headersSent) {
      r.destroy();
      return;
    }
    r.status(502).json({ error: '中文解说生成失败，请管理员检查语音服务网络与依赖' });
  }
});
function requestedSeat(q: express.Request): number | undefined {
  if (q.query.seat === undefined) return undefined;
  return z.enum(['0', '1', '2', '3']).transform(Number).parse(q.query.seat);
}
app.get('/api/state', (q, r) => {
  try {
    r.json(snapshot(requestedSeat(q)));
  } catch {
    r.status(400).json({ error: '视角座位无效' });
  }
});
app.get('/api/events', (q, r) => {
  let seat: number | undefined;
  try {
    seat = requestedSeat(q);
  } catch {
    r.status(400).json({ error: '视角座位无效' });
    return;
  }
  r.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  r.flushHeaders();
  clients.set(r, seat);
  r.write(`data: ${JSON.stringify(snapshot(seat))}\n\n`);
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
        .object({
          speech: z.boolean().optional(),
          showFeed: z.boolean().optional(),
          cameraMode: z.enum(['first', 'third']).optional(),
          viewpointSeat: z.number().int().min(0).max(3).optional(),
        })
        .strict()
        .parse(q.body.presentation);
      presentation = { ...presentation, ...settings };
      if (presentation.speech) void narrationAudio(narrationText()).catch(() => {});
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
    audioCacheBytes = 0;
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
