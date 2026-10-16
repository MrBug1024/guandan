import 'dotenv/config';
import express from 'express';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { defaults, decide, heuristic } from './agents.js';
import { applyMove, legalMoves, newGame, nextRound } from './rules.js';
import { publicState, safeAgent } from './public-state.js';
import { analyzeRound } from '../shared/analytics.js';
import { tableCall } from '../shared/voice-lines.js';
import { createAccess } from './access.js';
import { ROUND_CELEBRATION_MS } from '../shared/broadcast-timing.js';
import {
  DEFAULT_STUDY,
  type DecisionTrace,
  gameFrame,
  type AgentConfig,
  type Game,
  type Move,
  type PublicGame,
  type StudyProtocol,
} from '../shared/types.js';
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
await mkdir('data/replays', { recursive: true });
const access = await createAccess();
let delayMs = 1800,
  autoNext = true;
let agents: AgentConfig[] = structuredClone(defaults);
let study: StudyProtocol = structuredClone(DEFAULT_STUDY);
try {
  const saved = access.decrypt(JSON.parse(await readFile('data/agents.json', 'utf8')));
  agents = Array.isArray(saved) ? saved : saved.agents;
  if (!Array.isArray(agents) || agents.length !== 4) agents = structuredClone(defaults);
  if (!Array.isArray(saved)) {
    delayMs = saved.delayMs ?? 1800;
    autoNext = saved.autoNext ?? true;
    if (saved.study) study = { ...DEFAULT_STUDY, ...saved.study };
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
    study,
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
    study,
    presentation,
  };
}
function broadcast() {
  for (const [client, seat] of clients) client.write(`data: ${JSON.stringify(snapshot(seat))}\n\n`);
}
const Decision = Annotation.Root({
  game: Annotation<Game>(),
  config: Annotation<AgentConfig>(),
  moves: Annotation<Move[]>(),
  move: Annotation<Move>(),
  source: Annotation<string>(),
  reason: Annotation<string>(),
  decision: Annotation<DecisionTrace>(),
  error: Annotation<string>(),
});
const graph = new StateGraph(Decision)
  .addNode('observe', (s) => ({
    moves: legalMoves(s.game.hands[s.game.turn], s.game.level, s.game.last),
  }))
  .addNode('decide', async (s) => {
    try {
      return await decide(s.config, s.game, s.moves);
    } catch (error) {
      const move = heuristic(s.game, s.moves);
      const providerRequestCount =
        error && typeof error === 'object'
          ? Number((error as Error & { providerRequestCount?: number }).providerRequestCount ?? 0)
          : 0;
      return {
        move,
        source: '本地兜底',
        reason: '外部模型调用未成功，使用本地合法策略',
        decision: {
          method: 'fallback',
          candidateSource: 'unavailable',
          providerRequestCount,
          candidateCount: s.moves.length,
          legalActionCount: s.moves.length,
          selectedMoveId: move.id,
          rationale: '外部模型未返回有效选择，裁判改用本地策略。',
        },
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
      voiceLine: tableCall(move, result.moves.some((candidate: Move) => candidate.kind !== 'pass')),
      decision: result.decision,
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
  next();
});
app.get('/api/replays', async (_q, r) => {
  try {
    const files = await readdir(resolve('data/replays'), { withFileTypes: true });
    const rows = await Promise.all(
      files
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => {
          try {
            const replay = JSON.parse(await readFile(resolve('data/replays', entry.name), 'utf8'));
            const analytics = analyzeRound(replay.initial, replay.game, replay.agents);
            return {
              file: entry.name,
              gameId: replay.game.id,
              round: replay.game.round,
              level: replay.initial.level,
              status: replay.game.status,
              winner: replay.game.winner,
              finished: replay.game.finished,
              players: replay.agents.map((agent: AgentConfig) => ({
                name: agent.name,
                provider: agent.provider,
                model: agent.provider === 'builtin' ? '内置策略' : agent.model,
              })),
              study: replay.study ?? DEFAULT_STUDY,
              completedAt: replay.game.history.at(-1)?.time ?? null,
              ...analytics,
            };
          } catch {
            return undefined;
          }
        }),
    );
    r.json(
      rows
        .filter((row) => row !== undefined)
        .sort((a, b) => (b!.completedAt ?? '').localeCompare(a!.completedAt ?? ''))
        .slice(0, 200),
    );
  } catch {
    r.status(500).json({ error: '历史归档暂时无法读取' });
  }
});
app.get('/api/decisions', (_q, r) => {
  r.json({
    gameId: game.id,
    round: game.round,
    study,
    entries: game.history
      .filter((entry) => !entry.after || entry.after.round === game.round)
      .map(({ seq, seat, source, elapsedMs, time, move, error, decision }) => ({
        seq,
        seat,
        source,
        elapsedMs,
        time,
        move,
        error,
        decision,
      })),
  });
});
app.get('/api/replays/:file', async (q, r) => {
  const file = q.params.file;
  if (!/^[A-Za-z0-9-]+\.json$/.test(file)) {
    r.status(400).json({ error: '回放文件名无效' });
    return;
  }
  try {
    const replay = JSON.parse(await readFile(resolve('data/replays', file), 'utf8'));
    r.json(replay);
  } catch {
    r.status(404).json({ error: '找不到这份历史回放' });
  }
});
app.post('/api/control', async (q, r) => {
  try {
    if (q.body.action === 'presentation') {
      const settings = z
        .object({
          showFeed: z.boolean().optional(),
          cameraMode: z.enum(['first', 'third']).optional(),
          viewpointSeat: z.number().int().min(0).max(3).optional(),
        })
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
const studySchema = z
  .object({
    title: z.string().trim().min(1).max(60),
    question: z.string().trim().min(1).max(180),
    hypothesis: z.string().trim().min(1).max(240),
    measure: z.string().trim().min(1).max(240),
  })
  .strict();
app.get('/api/config', (_q, r) =>
  r.json({
    agents: agents.map(safeAgent),
    study,
    delayMs,
    autoNext,
  }),
);
app.put('/api/study', async (q, r) => {
  try {
    if (busy || game.status === 'running' ||
      (game.history.length > roundOffset && !['round-over', 'match-over'].includes(game.status)))
      throw Error('请在当前一局结束后、下一局开始前修改课题');
    const updated = studySchema.parse(q.body);
    await writeFile(
      'data/agents.json.tmp',
      JSON.stringify(access.encrypt({ agents, delayMs, autoNext, study: updated })),
      { mode: 0o600 },
    );
    await rename('data/agents.json.tmp', 'data/agents.json');
    study = updated;
    broadcast();
    r.json({ ok: true, study });
  } catch (e) {
    r.status(400).json({ error: e instanceof Error ? e.message : '课题配置错误' });
  }
});
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
        study: studySchema.optional(),
      })
      .parse(q.body);
    const updated = body.agents.map((config, i) => mergeKeys(config, agents[i]));
    const updatedStudy = body.study ?? study;
    await writeFile(
      'data/agents.json.tmp',
      JSON.stringify(
        access.encrypt({
          agents: updated,
          delayMs: body.delayMs,
          autoNext: body.autoNext,
          study: updatedStudy,
        }),
      ),
      { mode: 0o600 },
    );
    await rename('data/agents.json.tmp', 'data/agents.json');
    agents = updated;
    delayMs = body.delayMs;
    autoNext = body.autoNext;
    if (!autoNext) nextRoundAt = null;
    study = updatedStudy;
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
      providerRequestCount: result.decision.providerRequestCount ?? 0,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : '连接失败';
    const providerRequestCount =
      e && typeof e === 'object'
        ? Number((e as Error & { providerRequestCount?: number }).providerRequestCount ?? 0)
        : 0;
    r.status(400).json({
      error:
        message.startsWith('服务端环境变量') ||
        message.startsWith('模型 HTTP') ||
        message.startsWith('模型没有')
          ? message
          : '连接测试失败：请检查接口、Key、模型名称和返回结构。',
      providerRequestCount,
    });
  }
});
app.get('/api/replay', (_q, r) => r.attachment(`guandan-${game.id}.json`).json(replayData()));
app.use(express.static(resolve('dist')));
app.get('/{*path}', (_q, r) => r.sendFile(resolve('dist/index.html')));
app.use((err: Error, _q: express.Request, r: express.Response, _next: express.NextFunction) =>
  r.status(400).json({ error: err.message }),
);
const host = process.env.HOST ?? '0.0.0.0',
  port = Number(process.env.PORT ?? 3001);
app.listen(port, host, () => console.log(`掼蛋 AI 服务 http://${host}:${port}`));
