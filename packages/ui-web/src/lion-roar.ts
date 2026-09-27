// A short, friendly roar for Aiden, synthesized with Web Audio (no audio file to ship).
// Only ever called from a click, so browsers allow it; silently does nothing without audio.

type AudioContextConstructor = typeof AudioContext;

let context: AudioContext | undefined;

function audioContext(): AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  const Ctor: AudioContextConstructor | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  if (!Ctor) return undefined;
  context ??= new Ctor();
  return context;
}

const ROAR_SECONDS = 0.85;

export function playLionRoar(volume = 0.18): void {
  try {
    const ctx = audioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;

    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(volume, now + 0.06);
    out.gain.setValueAtTime(volume, now + 0.35);
    out.gain.exponentialRampToValueAtTime(0.0001, now + ROAR_SECONDS);
    out.connect(ctx.destination);

    // Growl: two detuned saws whose pitch rises then falls, through a sweeping lowpass.
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 6;
    filter.frequency.setValueAtTime(260, now);
    filter.frequency.exponentialRampToValueAtTime(1100, now + 0.25);
    filter.frequency.exponentialRampToValueAtTime(320, now + ROAR_SECONDS);
    filter.connect(out);

    for (const detune of [-14, 11]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.detune.value = detune;
      osc.frequency.setValueAtTime(95, now);
      osc.frequency.exponentialRampToValueAtTime(150, now + 0.2);
      osc.frequency.exponentialRampToValueAtTime(70, now + ROAR_SECONDS);
      // A fast wobble gives the growl its rumble.
      const wobble = ctx.createOscillator();
      const wobbleDepth = ctx.createGain();
      wobble.frequency.value = 28;
      wobbleDepth.gain.value = 9;
      wobble.connect(wobbleDepth).connect(osc.frequency);
      osc.connect(filter);
      osc.start(now);
      wobble.start(now);
      osc.stop(now + ROAR_SECONDS + 0.05);
      wobble.stop(now + ROAR_SECONDS + 0.05);
    }

    // Breath: filtered noise underneath.
    const noiseBuffer = ctx.createBuffer(
      1,
      Math.floor(ctx.sampleRate * ROAR_SECONDS),
      ctx.sampleRate,
    );
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.35;
    noise.connect(noiseGain).connect(filter);
    noise.start(now);
  } catch {
    // Audio is a flourish; never let it break a click.
  }
}
