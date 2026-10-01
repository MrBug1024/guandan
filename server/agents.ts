import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { cardName, type AgentConfig, type Game, type Move } from '../shared/types.js';
export const defaults: AgentConfig[] = [
  {
    name: '桃桃',
    provider: 'builtin',
    baseUrl: '',
    model: 'strategy-v1',
    keyEnv: '',
    personality: '冷静的队长，擅长配合',
  },
  {
    name: '蓝莓',
    provider: 'builtin',
    baseUrl: '',
    model: 'strategy-v1',
    keyEnv: '',
    personality: '机敏的战术家',
  },
  {
    name: '团子',
    provider: 'builtin',
    baseUrl: '',
    model: 'strategy-v1',
    keyEnv: '',
    personality: '稳健的守护者',
  },
  {
    name: '芒果',
    provider: 'builtin',
    baseUrl: '',
    model: 'strategy-v1',
    keyEnv: '',
    personality: '勇敢的进攻手',
  },
];
export function heuristic(g: Game, moves: Move[]): Move {
  const seat = g.turn;
  const partner = (seat + 2) % 4;
  if (
    g.last &&
    g.lastSeat === partner &&
    !g.finished.includes(partner) &&
    g.hands[seat].length > g.last.cards.length
  )
    return moves.find((m) => m.kind === 'pass')!;
  const playable = moves.filter((m) => m.kind !== 'pass');
  const bombs = ['bomb', 'flush', 'kings'];
  const score = (m: Move) =>
    m.cards.length * 15 -
    m.strength * 0.35 -
    (bombs.includes(m.kind) ? 45 : 0) -
    Object.keys(m.substitutions ?? {}).length * 6 +
    (m.cards.length === g.hands[seat].length ? 1000 : 0);
  return (
    [...playable].sort((a, b) => score(b) - score(a))[0] ?? moves.find((m) => m.kind === 'pass')!
  );
}
export function shortlist(g: Game, moves: Move[]): Move[] {
  const best = heuristic(g, moves);
  const rest = [...moves].sort(
    (a, b) => b.cards.length - a.cards.length || a.strength - b.strength,
  );
  const selected = [best, ...rest.filter((m) => m.id !== best.id).slice(0, 39)];
  const pass = moves.find((m) => m.kind === 'pass');
  if (pass && !selected.includes(pass)) selected.push(pass);
  return selected;
}
export function observation(g: Game, candidates: Move[]): string {
  return JSON.stringify({
    rules:
      '两副牌，对家组队。级牌大于A小于王。红桃级牌可配非王牌。四王>六张及以上炸弹>同花顺>五炸>四炸。同队头游二游升3级、头游三游升2级、头游末游升1级；必须实际打A且对家非末游才能通关。只选择给定动作；不要假设其他玩家手牌。',
    seat: g.turn,
    partner: (g.turn + 2) % 4,
    level: g.level,
    levels: g.levels,
    round: g.round,
    tribute: g.tribute,
    hand: g.hands[g.turn].map(cardName),
    counts: g.hands.map((h) => h.length),
    finished: g.finished,
    last: g.last ? { seat: g.lastSeat, label: g.last.label } : null,
    publicHistory: g.history.slice(-16).map((e) => ({ seat: e.seat, text: e.text })),
    candidates: candidates.map((m, i) => ({
      choice: i,
      id: m.id,
      label: m.label,
      substitutions: m.substitutions,
    })),
  });
}
function key(config: { keyEnv: string; apiKey?: string }): string {
  const value = config.apiKey || process.env[config.keyEnv];
  if (!value) throw Error(`服务端环境变量 ${config.keyEnv || '(未配置)'} 未设置`);
  return value;
}
function parseJson(text: string): unknown {
  const clean = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  return JSON.parse(clean);
}
export async function jevAdvice(
  config: { baseUrl: string; keyEnv: string; apiKey?: string },
  situation: string,
  candidates: Move[],
) {
  let index: number = NaN;
  const client = new Client({ name: 'guandan-arena', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(config.baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${key(config)}` } },
  });
  try {
    await client.connect(transport, { timeout: 45000 });
    const response = await client.callTool(
      {
        name: 'jev_decide',
        arguments: {
          situation,
          questions: [
            {
              type: 'choice',
              question: '哪个合法动作最有利于我方合作获胜？',
              options: candidates.map((m, i) => `${i}: ${m.label}`),
            },
          ],
        },
      },
      undefined,
      { timeout: 45000 },
    );
    if (response.isError) throw Error('JEV 工具返回错误');
    const data = (response.structuredContent ??
      parseJson(
        (response.content as any[])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n'),
      )) as any;
    const result = data.results?.[0];
    const selected = result?.choice ?? result?.answer ?? result?.selected ?? result?.label;
    index =
      typeof selected === 'number'
        ? selected
        : typeof selected === 'string'
          ? Number(selected.match(/^\d+/)?.[0])
          : NaN;
    if (!Number.isInteger(index)) {
      const probs = result?.probabilities ?? result?.probs;
      if (Array.isArray(probs) && probs.length === candidates.length)
        index = probs.indexOf(Math.max(...probs.map((p: any) => Number(p))));
    }
  } finally {
    await client.close().catch(() => {});
  }
  if (!Number.isInteger(index) || index < 0 || index >= candidates.length)
    throw Error('JEV 没有返回有效的选项编号');
  return { choice: index, label: candidates[index].label };
}
export async function decide(
  config: AgentConfig,
  g: Game,
  moves: Move[],
): Promise<{ move: Move; source: string; reason: string }> {
  if (config.provider === 'builtin')
    return {
      move: heuristic(g, moves),
      source: '本地策略',
      reason: '根据手牌结构与队友位置选择合法动作',
    };
  if (moves.length === 1)
    return { move: moves[0], source: '裁判强制动作', reason: '仅有一个合法动作，无需调用模型' };
  const candidates = shortlist(g, moves),
    situation = observation(g, candidates);
  const messages: any[] = [
    {
      role: 'system',
      content: `你是掼蛋选手。${config.personality}。仅输出 JSON {"choice":整数,"reason":"简短公开解说"}，不得声称知道其他玩家手牌。${config.jev?.enabled ? '可调用 jev_decide 获取辅助建议，但最终选择由你决定。工具只了解你的手牌和公开信息。若接口不支持原生工具调用，可以输出 JSON {"tool":"jev_decide"} 请求建议，收到建议后再输出最终 choice。' : ''}`,
    },
    { role: 'user', content: situation },
  ];
  const tool = {
    type: 'function',
    function: {
      name: 'jev_decide',
      description: '咨询 JEV 辅助决策模型，对当前合法动作获取建议。最终决策由选手负责。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  };
  let result: any,
    usedTool = false,
    toolFailed = false,
    textTools = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    for (let retry = 0; ; retry++) {
      response = await fetch(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key(config)}` },
        signal: AbortSignal.timeout(45000),
        body: JSON.stringify({
          model: config.model,
          ...(!/kimi/i.test(config.model) ? { temperature: 0.3 } : {}),
          max_tokens: 4096,
          ...(/minimax|kimi|qwen/i.test(config.model)
            ? { thinking: { type: 'disabled' }, enable_thinking: false }
            : {}),
          messages,
          ...(config.jev?.enabled && !textTools
            ? { tools: [tool], tool_choice: attempt === 0 ? 'auto' : 'none' }
            : {}),
        }),
      });
      if (response.status >= 500 && retry === 0) {
        if (config.jev?.enabled && attempt === 0) textTools = true;
        continue;
      }
      break;
    }
    if (!response.ok) throw Error(`模型 HTTP ${response.status}`);
    const json = (await response.json()) as any,
      message = json.choices?.[0]?.message;
    if (attempt === 0 && config.jev?.enabled && message?.tool_calls?.length) {
      if (message.tool_calls.length > 4) throw Error('模型工具调用过多');
      messages.push(message);
      for (const call of message.tool_calls) {
        let advice: unknown;
        if (call.function?.name !== 'jev_decide') advice = { error: '未知工具' };
        else {
          usedTool = true;
          try {
            advice = await jevAdvice(config.jev, situation, candidates);
          } catch {
            toolFailed = true;
            advice = { error: 'JEV 暂不可用，请独立选择合法动作' };
          }
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(advice) });
      }
      continue;
    }
    result = parseJson((message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, ''));
    if (attempt === 0 && config.jev?.enabled && result?.tool === 'jev_decide') {
      usedTool = true;
      let advice: unknown;
      try {
        advice = await jevAdvice(config.jev, situation, candidates);
      } catch {
        toolFailed = true;
        advice = { error: 'JEV 暂不可用，请独立选择合法动作' };
      }
      messages.push(
        { role: 'assistant', content: JSON.stringify(result) },
        {
          role: 'user',
          content:
            'jev_decide 工具返回：' +
            JSON.stringify(advice) +
            '。请你现在决定最终出牌，只输出 choice 和 reason 的 JSON。',
        },
      );
      continue;
    }
    break;
  }
  const index = result?.choice;
  if (!Number.isInteger(index) || index < 0 || index >= candidates.length)
    throw Error('模型没有返回有效的选项编号');
  return {
    move: candidates[index],
    source: config.model,
    reason:
      String(result.reason ?? '模型选择').slice(0, 180) +
      (usedTool ? (toolFailed ? '（JEV 未成功，选手自主决策）' : '（咨询 JEV）') : ''),
  };
}
