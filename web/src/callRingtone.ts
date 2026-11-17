export class CallRingtone {
  private context: AudioContext | null = null;

  constructor(private readonly onReady: (ready: boolean) => void) {}

  async unlock(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext();
      this.context.onstatechange = () => this.onReady(this.isReady());
    }
    await this.context.resume();
    this.onReady(this.isReady());
  }

  isReady(): boolean {
    return this.context?.state === 'running';
  }

  play(): boolean {
    const context = this.context;
    if (!context || !this.isReady()) return false;
    const start = context.currentTime + 0.02;
    for (const [offset, frequency] of [[0, 659], [0.18, 880], [0.55, 659], [0.73, 880]]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const time = start + offset;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(0.07, time + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.23);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(time);
      oscillator.stop(time + 0.25);
    }
    return true;
  }

  close(): void {
    if (!this.context) return;
    this.context.onstatechange = null;
    void this.context.close().catch(() => {});
    this.context = null;
  }
}

function storedCall(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

export async function ringOnce(key: string, callId: number, play: () => boolean): Promise<void> {
  const ring = () => {
    if (storedCall(key) >= callId || !play()) return;
    try { localStorage.setItem(key, String(callId)); } catch { /* La sonnerie reste disponible sans stockage. */ }
  };
  if (navigator.locks) {
    await navigator.locks.request(key, ring);
    return;
  }

  // Sur HTTP sans Web Locks, le dernier onglet candidat effectue la lecture.
  const candidateKey = key + '.candidate';
  const candidate = Math.random().toString(36).slice(2);
  try {
    localStorage.setItem(candidateKey, candidate);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
    if (localStorage.getItem(candidateKey) === candidate) ring();
  } catch {
    ring();
  }
}
