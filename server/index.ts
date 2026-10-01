import 'dotenv/config';
import express from 'express';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { defaults, decide, heuristic } from './agents.js';
import { applyMove, legalMoves, newGame, nextRound } from './rules.js';
import { publicState } from './public-state.js';
import {
  gameFrame,
  type AgentConfig,
  type Game,
  type Move,
  type PublicGame,
} from '../shared/types.js';
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
await mkdir('data/replays', { recursive: true });
let delayMs = 1800,
  autoNext = true;
let agents: AgentConfig[] = structuredClone(defaults);
try {
  const saved = JSON.parse(await readFile('data/agents.json', 'utf8'));
  agents = Array.isArray(saved) ? saved : saved.agents;
  if (!Array.isArray(agents) || agents.length !== 4) agents = structuredClone(defaults);
  if (!Array.isArray(saved)) {
    delayMs = saved.delayMs ?? 1800;
    autoNext = saved.autoNext ?? true;
  }
} catch {}
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
    agents,
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
  return { ...publicState(game, agents, { thinking, delayMs, autoNext, nextRoundAt }), presentation };
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
    busy = false;
    thinking = null;
    broadcast();
  }
}
let timer: ReturnType<typeof setTimeout> | undefined;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(
    async () => {
      try {
        if (game.status === 'running') await step();
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
        game.status = 'paused';
        console.error('对局暂停:', e instanceof Error ? e.message : '未知错误');
        broadcast();
      } finally {
        schedule();
      }
    },
    game.status === 'round-over' && nextRoundAt !== null ? 250 : delayMs,
  );
}
schedule();
app.get('/api/health', (_q, r) => r.json({ ok: true, version: '0.1.0' }));
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
  const token = process.env.CONTROL_TOKEN;
  if (token && q.headers.authorization !== `Bearer ${token}`) {
    r.status(401).json({ error: '控制口令错误' });
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
      const settings = z.object({ speech: z.boolean().optional(), showFeed: z.boolean().optional() }).strict().parse(q.body.presentation);
      presentation = { ...presentation, ...settings };
      broadcast();
      r.json(snapshot());
      return;
    }
    const { action } = z
      .object({ action: z.enum(['start', 'pause', 'step', 'reset', 'next']) })
      .parse(q.body);
    if (action === 'pause') {
      game.status = game.status === 'running' ? 'paused' : game.status;
      nextRoundAt = null;
      epoch++;
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
        keyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
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
      if (!v.keyEnv) c.addIssue({ code: 'custom', message: '请填写服务端 Key 环境变量名' });
      if (v.provider === 'openai' && !v.model)
        c.addIssue({ code: 'custom', message: '请填写模型名称' });
    }
  });
app.put('/api/config', async (q, r) => {
  try {
    if (busy || game.status === 'running') throw Error('请先暂停并等待决策完成');
    const body = z
      .object({
        agents: z.array(configSchema).length(4),
        delayMs: z.number().int().min(300).max(30000),
        autoNext: z.boolean(),
      })
      .parse(q.body);
    agents = body.agents;
    delayMs = body.delayMs;
    autoNext = body.autoNext;
    if (!autoNext) nextRoundAt = null;
    await writeFile('data/agents.json.tmp', JSON.stringify({ agents, delayMs, autoNext }, null, 2));
    await rename('data/agents.json.tmp', 'data/agents.json');
    broadcast();
    r.json({ ok: true });
  } catch (e) {
    r.status(400).json({ error: e instanceof Error ? e.message : '配置错误' });
  }
});
app.post('/api/test', async (q, r) => {
  try {
    const config = configSchema.parse(q.body);
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
if (!['localhost', '127.0.0.1', '::1'].includes(host) && !process.env.CONTROL_TOKEN)
  throw Error('对外监听必须设置 CONTROL_TOKEN');
app.listen(port, host, () => console.log(`掼蛋 AI 服务 http://${host}:${port}`));
