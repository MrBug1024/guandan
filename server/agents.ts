import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  cardName,
  type AgentConfig,
  type DecisionTrace,
  type Game,
  type Move,
} from '../shared/types.js';
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
function heuristicRationale(g: Game, move: Move): string {
  const seat = g.turn;
  if (move.kind === 'pass') return '当前没有合适的压制动作，选择让牌并保留手牌结构。';
  if (move.cards.length === g.hands[seat].length) return `本手可一次打空 ${move.cards.length} 张手牌，直接完成出清。`;
  if (['bomb', 'flush', 'kings'].includes(move.kind))
    return `使用${move.label}压过当前牌权；高强度牌型代价较高，只有局势需要时才值得消耗。`;
  if (Object.keys(move.substitutions ?? {}).length)
    return `用逢人配组成${move.label}，一次脱手 ${move.cards.length} 张；同时权衡万能牌的后续价值。`;
  if (g.last && g.lastSeat % 2 !== seat % 2)
    return `压过对手刚领出的${g.last.label.split(' · ')[0]}，争取接管牌权并脱手 ${move.cards.length} 张。`;
  return `以${move.label}一次脱手 ${move.cards.length} 张；本地评分兼顾牌数、牌力与炸弹消耗。`;
}
function heuristicTacticalRead(g: Game): string | undefined {
  const seat = g.turn;
  const threatCount = g.hands.reduce((best, hand, index) =>
    index % 2 !== seat % 2 && hand.length > 0 ? Math.min(best, hand.length) : best, Infinity);
  if (threatCount <= 5)
    return `对手最少剩 ${threatCount} 张，可能正在寻找短牌型脱手；张数不能揭示具体牌面。`;
  if (!g.last) return undefined;
  if (g.lastSeat % 2 === seat % 2)
    return `队友已领出${g.last.label.split(' · ')[0]}；后续动作可观察队友能否继续保持牌权。`;
  return `对手刚领出${g.last.label.split(' · ')[0]}；单次出牌不足以判断其整手牌型或后续意图。`;
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
      '两副牌，对家组队。级牌大于A小于王。红桃级牌可配非王牌。四王>六张及以上炸弹>同花顺>五炸>四炸。同队头游二游升3级、头游三游升2级、头游末游升1级；升级按当前级牌加级且不降低已取得的更高等级，封顶A。必须实际打A且对家非末游才能通关；选择本副级牌的队伍累计三次过A失败降回2。顺时针出牌；出完无人接牌由对家接风。只选择给定动作；不要假设其他玩家手牌。',
    seat: g.turn,
    partner: (g.turn + 2) % 4,
    level: g.level,
    levels: g.levels,
    aFailures: g.aFailures ?? [0, 0],
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
): Promise<{ move: Move; source: string; reason: string; decision: DecisionTrace }> {
  if (config.provider === 'builtin') {
    const move = heuristic(g, moves);
    const protectedPartnerLead =
      g.last && g.lastSeat === (g.turn + 2) % 4 &&
      !g.finished.includes(g.lastSeat) &&
      g.hands[g.turn].length > g.last.cards.length;
    const reason = protectedPartnerLead
      ? '固定规则：搭档已领出且可保留牌权时，本地策略优先让牌。'
      : heuristicRationale(g, move);
    const tacticalRead = heuristicTacticalRead(g);
    return {
      move,
      source: '本地策略',
      reason,
      decision: {
        method: 'heuristic',
        candidateSource: 'legal-action-set',
        providerRequestCount: 0,
        candidateCount: moves.length,
        legalActionCount: moves.length,
        selectedMoveId: move.id,
        rationale: reason,
          ...(tacticalRead ? { tacticalRead } : {}),
      },
    };
  }
  if (moves.length === 1)
    return {
      move: moves[0],
      source: '裁判强制动作',
      reason: '仅有一个合法动作，无需调用模型。',
      decision: {
        method: 'forced',
        candidateSource: 'forced',
        providerRequestCount: 0,
        candidateCount: 1,
        legalActionCount: 1,
        selectedMoveId: moves[0].id,
        rationale: '仅有一个合法动作，无需调用模型。',
      },
    };
  const candidates = shortlist(g, moves),
    situation = observation(g, candidates);
  const messages: any[] = [
    {
      role: 'system',
      content: `你是掼蛋选手。${config.personality}。只输出 JSON {"choice":整数,"reason":"简短公开决策说明","read":"基于公开行动的战术推测","moment":"routine|tactical|critical"}。reason 只用一句自然、具体的话说明这手实际选择的关键取舍，不输出隐藏思维链，不编造情绪、手牌或意图；角色个性只影响风险偏好、协作风格和措辞。moment 只在真实有看点时标记：routine=强制动作、常规跟牌或没有实质取舍；tactical=在让牌/争牌权、手牌结构、队友协作或资源消耗之间确有取舍；critical=这手涉及炸弹等高价值牌，或直接决定出完/应对即将出完的对手。拿不准就选 routine。read 仅在公开历史和剩余张数支持一个有不确定性的对手倾向推测时填写，不得声称知道他人手牌或内心意图；证据不足时为空字符串。${config.jev?.enabled ? '可调用 jev_decide 获取辅助建议，但最终选择由你决定。工具只了解你的手牌和公开信息。若接口不支持原生工具调用，可以输出 JSON {"tool":"jev_decide"} 请求建议，收到建议后再输出最终 choice。' : ''}`,
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
  const authorization = `Bearer ${key(config)}`;
  let result: any,
    usedTool = false,
    toolFailed = false,
    textTools = false,
    providerRequestCount = 0;
  try {
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    for (let retry = 0; ; retry++) {
      providerRequestCount++;
      response = await fetch(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization },
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
  if (!response.ok) {
    const error = Error(`模型 HTTP ${response.status}`);
    Object.assign(error, { providerRequestCount });
    throw error;
  }
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
    try {
      result = parseJson((message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, ''));
    } catch (error) {
      if (error && typeof error === 'object') Object.assign(error, { providerRequestCount });
      throw error;
    }
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
            '。请你现在决定最终出牌，只输出 choice、reason、read、moment 的 JSON。',
        },
      );
      continue;
    }
    break;
  }
  } catch (error) {
    if (error && typeof error === 'object')
      Object.assign(error, { providerRequestCount });
    throw error;
  }
  const index = result?.choice;
  if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
    const error = Error('模型没有返回有效的选项编号');
    Object.assign(error, { providerRequestCount });
    throw error;
  }
  const rawReason = typeof result.reason === 'string' ? result.reason.trim() : '';
  const reason = String(rawReason || '模型选择').slice(0, 140) +
    (usedTool ? (toolFailed ? '（JEV 未成功，选手自主决策）' : '（咨询 JEV）') : '');
  const tacticalRead = typeof result.read === 'string' ? result.read.trim().slice(0, 120) : '';
  const move = candidates[index];
  const opponentThreat = g.hands.some((hand, seat) =>
    seat % 2 !== g.turn % 2 && hand.length > 0 && hand.length <= 2,
  );
  const criticalState = ['bomb', 'plate', 'flush', 'kings'].includes(move.kind) ||
    g.hands[g.turn].length - move.cards.length <= 2 || opponentThreat;
  const moment = rawReason && result.moment === 'critical' && criticalState
    ? 'critical'
    : rawReason && result.moment === 'tactical'
      ? 'tactical'
      : 'routine';
  return {
    move,
    source: config.model,
    reason,
    decision: {
      method: 'model',
      candidateSource: 'model-shortlist',
      providerRequestCount,
      candidateCount: candidates.length,
      legalActionCount: moves.length,
      candidates: candidates.map((candidate, candidateIndex) => ({
        index: candidateIndex,
        moveId: candidate.id,
        kind: candidate.kind,
        label: candidate.label,
        cardCount: candidate.cards.length,
        strength: candidate.strength,
      })),
      choiceIndex: index,
      selectedMoveId: move.id,
      rationale: reason,
      moment,
      ...(tacticalRead ? { tacticalRead } : {}),
    },
  };
}
