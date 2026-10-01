import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Move } from '../shared/types.js';

const run = promisify(execFile);
export function spokenMove(name: string, move?: Move): string {
  if (!move || move.kind === 'pass') return `${name}选择不出。`;
  const rank = (r: number) => ({ 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '十', 11: '勾', 12: '圈', 13: '凯', 14: '尖', 15: '小王', 16: '大王' })[r] ?? String(r);
  const ranks = move.cards.map(c => move.substitutions?.[c.id] ?? c.rank);
  const counts = new Map<number, number>();
  ranks.forEach(r => counts.set(r, (counts.get(r) ?? 0) + 1));
  const groups = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  let phrase: string;
  switch (move.kind) {
    case 'single': phrase = `${({ S: '黑桃', H: '红桃', C: '梅花', D: '方块', J: '' })[move.cards[0].suit]}${rank(ranks[0])}`; break;
    case 'pair': phrase = `一对${rank(ranks[0])}`; break;
    case 'triple': phrase = `三个${rank(ranks[0])}`; break;
    case 'fullhouse': phrase = `三个${rank(groups[0][0])}带一对${rank(groups[1][0])}`; break;
    case 'bomb': phrase = `${move.cards.length}张${rank(groups[0][0])}的炸弹`; break;
    case 'kings': phrase = '四大天王'; break;
    default: phrase = `${({ straight: '顺子', flush: '同花顺', pairs: '三连对', plate: '钢板' })[move.kind]}，${[...counts.keys()].sort((a,b) => a-b).map(rank).join('、')}`;
  }
  return `${name}打出${phrase}。`;
}

// Neural Mandarin is the default, independently of the spectator's browser/OS.
// Do not silently replace it with the much less intelligible eSpeak voice on failure.
export async function naturalNarration(text: string): Promise<Buffer> {
  const python = process.env.NARRATION_PYTHON || (process.platform === 'win32'
    ? (existsSync('tmp/voice-venv/Scripts/python.exe') ? 'tmp/voice-venv/Scripts/python.exe' : 'python')
    : '/opt/voice/bin/python');
  const dir = await mkdtemp(join(tmpdir(), 'guandan-neural-'));
  const file = join(dir, 'voice.mp3');
  try {
    await run(python, ['-m', 'edge_tts', '--voice', 'zh-CN-XiaoxiaoNeural', '--rate=-8%',
      '--text', text, '--write-media', file], { timeout: 20000, maxBuffer: 100000 });
    const audio = await readFile(file);
    if (audio.length < 1000 || audio.length > 2000000 ||
      !(audio.subarray(0, 3).toString() === 'ID3' || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)))
      throw Error('invalid neural audio');
    return audio;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
