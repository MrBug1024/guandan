let audioContext: AudioContext | undefined;

function context() {
  if (!audioContext && window.AudioContext) audioContext = new AudioContext();
  return audioContext;
}

function tone(startHz: number, endHz: number, duration: number, type: OscillatorType, volume: number) {
  const ctx = context();
  if (!ctx) return;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  const now = ctx.currentTime;
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(startHz, now);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, endHz), now + duration);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(now);
  oscillator.stop(now + duration);
}

function explosion() {
  const ctx = context();
  if (!ctx) return;
  const duration = 0.3;
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * duration), ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let index = 0; index < samples.length; index++)
    samples[index] = (Math.random() * 2 - 1) * (1 - index / samples.length);

  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  const now = ctx.currentTime;
  source.buffer = buffer;
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(2400, now);
  filter.frequency.exponentialRampToValueAtTime(180, now + duration);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.075, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  source.start(now);
  source.stop(now + duration);
  tone(120, 38, 0.27, 'sawtooth', 0.07);
  tone(620, 110, 0.13, 'triangle', 0.025);
}

export async function enableTableAudio(): Promise<boolean> {
  const ctx = context();
  if (ctx?.state === 'suspended') await ctx.resume();
  tone(420, 660, 0.09, 'sine', 0.035);
  return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

export function playTableEffect(kind: string) {
  if (kind === 'tribute-anti') {
    tone(520, 1040, 0.2, 'sine', 0.045);
    return;
  }
  if (kind === 'tribute') {
    tone(660, 880, 0.12, 'triangle', 0.035);
    return;
  }
  if (['bomb', 'flush', 'kings'].includes(kind)) {
    explosion();
    return;
  }
  if (['plate', 'straight', 'pairs'].includes(kind)) {
    tone(620, 920, 0.1, 'triangle', 0.03);
    return;
  }
  tone(480, 360, 0.055, 'triangle', 0.022);
}

const seatVoices = [
  { rate: 0.98, pitch: 0.78 },
  { rate: 1.1, pitch: 1.2 },
  { rate: 1.03, pitch: 0.98 },
  { rate: 1.14, pitch: 0.86 },
] as const;

export function speakTableLine(text: string, seat = 0) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const voiceIndex = (seat % 4 + 4) % 4;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = seatVoices[voiceIndex].rate;
  utterance.pitch = seatVoices[voiceIndex].pitch;
  utterance.volume = 0.92;
  const voices = window.speechSynthesis.getVoices().filter(
    (item) => item.lang.toLowerCase().startsWith('zh'),
  );
  const voice = voices[voiceIndex % Math.max(1, voices.length)];
  if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
}

export function stopTableVoice() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}
