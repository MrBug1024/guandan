import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
export async function localNarration(text: string): Promise<Buffer> {
  if (process.platform !== 'win32') {
    const { stdout } = await run('espeak-ng', ['-v', 'cmn', '-s', '185', '--stdout', text],
      { encoding: 'buffer', timeout: 15000, maxBuffer: 2000000 });
    // eSpeak's streaming WAV uses a placeholder length; finalize it for browsers.
    const audio = Buffer.from(stdout);
    audio.writeUInt32LE(audio.length - 8, 4);
    const offset = audio.indexOf(Buffer.from('data'), 12);
    if (offset >= 0) audio.writeUInt32LE(audio.length - offset - 8, offset + 4);
    return audio;
  }
  const dir = await mkdtemp(join(tmpdir(), 'guandan-voice-'));
  const file = join(dir, 'voice.wav');
  try {
    const script = `Add-Type -AssemblyName System.Speech
      $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
      try {
        $s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet, [System.Speech.Synthesis.VoiceAge]::NotSet, 0, [System.Globalization.CultureInfo]::GetCultureInfo('zh-CN'))
        $s.SetOutputToWaveFile($env:GUANDAN_VOICE_FILE)
        $s.Speak($env:GUANDAN_VOICE_TEXT)
      } finally { $s.Dispose() }`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: 15000, env: { ...process.env, GUANDAN_VOICE_FILE: file, GUANDAN_VOICE_TEXT: text } });
    return await readFile(file);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
