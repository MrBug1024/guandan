import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Move } from '../shared/types.js';

export function spokenMove(name: string, move?: Move): string {
  if (!move || move.kind === 'pass') return `${name}选择不出。`;
  const rank = (r: number) =>
    ({
      2: '二',
      3: '三',
      4: '四',
      5: '五',
      6: '六',
      7: '七',
      8: '八',
      9: '九',
      10: '十',
      11: '勾',
      12: '圈',
      13: '凯',
      14: '尖',
      15: '小王',
      16: '大王',
    })[r] ?? String(r);
  const ranks = move.cards.map((c) => move.substitutions?.[c.id] ?? c.rank);
  const counts = new Map<number, number>();
  ranks.forEach((r) => counts.set(r, (counts.get(r) ?? 0) + 1));
  const groups = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  let phrase: string;
  switch (move.kind) {
    case 'single':
      phrase = `${{ S: '黑桃', H: '红桃', C: '梅花', D: '方块', J: '' }[move.cards[0].suit]}${rank(ranks[0])}`;
      break;
    case 'pair':
      phrase = `一对${rank(ranks[0])}`;
      break;
    case 'triple':
      phrase = `三个${rank(ranks[0])}`;
      break;
    case 'fullhouse':
      phrase = `三个${rank(groups[0][0])}带一对${rank(groups[1][0])}`;
      break;
    case 'bomb':
      phrase = `${move.cards.length}张${rank(groups[0][0])}的炸弹`;
      break;
    case 'kings':
      phrase = '四大天王';
      break;
    default:
      phrase = `${{ straight: '顺子', flush: '同花顺', pairs: '三连对', plate: '钢板' }[move.kind]}，${[
        ...counts.keys(),
      ]
        .sort((a, b) => a - b)
        .map(rank)
        .join('、')}`;
  }
  return `${name}打出${phrase}。`;
}

let worker: ChildProcessWithoutNullStreams | undefined;
let nextId = 0;
const pending = new Map<
  number,
  {
    resolve: (audio: Buffer) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    onChunk?: (audio: Buffer) => void;
  }
>();
function voiceWorker() {
  if (worker && !worker.killed) return worker;
  const python =
    process.env.NARRATION_PYTHON ||
    (process.platform === 'win32'
      ? existsSync('tmp/voice-venv/Scripts/python.exe')
        ? 'tmp/voice-venv/Scripts/python.exe'
        : 'python'
      : '/opt/voice/bin/python');
  const processHandle = spawn(
    python,
    ['-u', fileURLToPath(new URL('./voice_worker.py', import.meta.url))],
    { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } },
  );
  worker = processHandle;
  processHandle.unref();
  for (const stream of [processHandle.stdin, processHandle.stdout, processHandle.stderr])
    (stream as any).unref?.();
  processHandle.stderr.resume();
  const lines = createInterface({ input: processHandle.stdout });
  lines.on('line', (line) => {
    try {
      const response = JSON.parse(line);
      const job = pending.get(response.id);
      if (!job) return;
      if (response.chunk) {
        job.onChunk?.(Buffer.from(response.chunk, 'base64'));
        return;
      }
      pending.delete(response.id);
      clearTimeout(job.timer);
      const audio = response.audio ? Buffer.from(response.audio, 'base64') : Buffer.alloc(0);
      if (
        audio.length < 1000 ||
        audio.length > 2000000 ||
        !(
          audio.subarray(0, 3).toString() === 'ID3' ||
          (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)
        )
      )
        job.reject(Error('中文音频生成失败'));
      else job.resolve(audio);
    } catch {
      /* Ignore malformed worker output; requests retain their timeout. */
    }
  });
  const failed = () => {
    if (worker !== processHandle) return;
    worker = undefined;
    lines.close();
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(Error('中文音频进程不可用'));
    }
    pending.clear();
  };
  processHandle.on('error', failed);
  processHandle.on('exit', failed);
  processHandle.stdin.on('error', failed);
  return processHandle;
}
export function naturalNarration(text: string, onChunk?: (audio: Buffer) => void): Promise<Buffer> {
  if (pending.size >= 8) return Promise.reject(Error('解说服务繁忙'));
  const voice = voiceWorker(),
    id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error('解说生成超时'));
    }, 20000);
    pending.set(id, { resolve, reject, timer, onChunk });
    voice.stdin.write(JSON.stringify({ id, text }) + '\n');
  });
}
