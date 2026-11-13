import { api } from './api';
import type { ChatSocket } from './ws';

export interface CallSessionHandlers {
  onRemoteStream: (userId: number, stream: MediaStream) => void;
  onPeerRemoved: (userId: number) => void;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
let iceServersCache: RTCIceServer[] | null = null;

async function loadIceServers(): Promise<RTCIceServer[]> {
  if (iceServersCache) return iceServersCache;
  try {
    const cfg = await api.rtcConfig();
    iceServersCache = cfg.iceServers?.length ? cfg.iceServers : DEFAULT_ICE_SERVERS;
  } catch {
    iceServersCache = DEFAULT_ICE_SERVERS;
  }
  return iceServersCache;
}

export class CallSession {
  private pcs = new Map<number, RTCPeerConnection>();
  private remoteStreams = new Map<number, MediaStream>();
  private localStream: MediaStream | null = null;
  private videoStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  private recordCtx: AudioContext | null = null;
  private unlockCtx: AudioContext | null = null;
  private readonly ws: ChatSocket;
  private readonly userId: number;
  private readonly handlers: CallSessionHandlers;

  constructor(ws: ChatSocket, userId: number, handlers: CallSessionHandlers) {
    this.ws = ws;
    this.userId = userId;
    this.handlers = handlers;
  }

  private unlockAudio(): void {
    try {
      if (!this.unlockCtx) this.unlockCtx = new AudioContext();
      void this.unlockCtx.resume();
      const ctx = this.unlockCtx;
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      // ignore
    }
  }

  async start(): Promise<MediaStream> {
    await loadIceServers();
    this.unlockAudio();
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return this.localStream;
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getScreenStream(): MediaStream | null {
    return this.screenStream;
  }

  getVideoStream(): MediaStream | null {
    return this.videoStream;
  }

  async startCamera(): Promise<MediaStream> {
    this.videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const track = this.videoStream.getVideoTracks()[0];
    for (const peerId of [...this.pcs.keys()]) {
      const pc = this.pcs.get(peerId);
      if (pc && this.videoStream) {
        pc.addTrack(track, this.videoStream);
        await this.sendOffer(peerId);
      }
    }
    return this.videoStream;
  }

  async stopCamera(): Promise<void> {
    if (!this.videoStream) return;
    const tracks = this.videoStream.getTracks();
    for (const t of tracks) t.stop();
    for (const peerId of [...this.pcs.keys()]) {
      const pc = this.pcs.get(peerId);
      if (!pc) continue;
      for (const sender of pc.getSenders()) {
        if (sender.track && tracks.includes(sender.track)) pc.removeTrack(sender);
      }
      await this.sendOffer(peerId);
    }
    this.videoStream = null;
  }

  hasPeer(peerId: number): boolean {
    return this.pcs.has(peerId);
  }

  private createPc(peerId: number): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: iceServersCache ?? DEFAULT_ICE_SERVERS });
    this.pcs.set(peerId, pc);
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) pc.addTrack(t, this.localStream);
    }
    if (this.videoStream) {
      for (const t of this.videoStream.getTracks()) pc.addTrack(t, this.videoStream);
    }
    if (this.screenStream) {
      for (const t of this.screenStream.getTracks()) pc.addTrack(t, this.screenStream);
    }
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.ws.sendRaw({ type: 'signal', to: peerId, data: { candidate: ev.candidate.toJSON() } });
      }
    };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (stream) {
        this.unlockAudio();
        this.remoteStreams.set(peerId, stream);
        this.handlers.onRemoteStream(peerId, stream);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
        this.pcs.delete(peerId);
        this.remoteStreams.delete(peerId);
        this.handlers.onPeerRemoved(peerId);
      }
    };
    return pc;
  }

  private async sendOffer(peerId: number): Promise<void> {
    const pc = this.pcs.get(peerId);
    if (!pc) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.ws.sendRaw({ type: 'signal', to: peerId, data: { sdp: pc.localDescription } });
  }

  async connectTo(peerId: number): Promise<void> {
    if (peerId === this.userId || this.pcs.has(peerId)) return;
    this.createPc(peerId);
    await this.sendOffer(peerId);
  }

  async handleSignal(from: number, data: unknown): Promise<void> {
    if (from === this.userId) return;
    const d = data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
    let pc = this.pcs.get(from);
    if (!pc) pc = this.createPc(from);
    try {
      if (d.sdp) {
        if (d.sdp.type === 'offer') {
          await pc.setRemoteDescription(d.sdp);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.ws.sendRaw({ type: 'signal', to: from, data: { sdp: pc.localDescription } });
        } else if (d.sdp.type === 'answer') {
          await pc.setRemoteDescription(d.sdp);
        }
      } else if (d.candidate) {
        await pc.addIceCandidate(d.candidate);
      }
    } catch {
      // état de signalisation transitoire ignoré
    }
  }

  setMuted(muted: boolean): void {
    this.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }

  async startScreenShare(): Promise<MediaStream> {
    if (!('getDisplayMedia' in navigator.mediaDevices)) {
      throw new Error("Partage d'écran non supporté par ce navigateur (ex. Safari iOS). Utilise un PC ou un téléphone Android.");
    }
    this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = this.screenStream.getVideoTracks()[0];
    if (track) {
      track.onended = () => {
        void this.stopScreenShare();
      };
    }
    for (const peerId of [...this.pcs.keys()]) {
      const pc = this.pcs.get(peerId);
      if (pc && this.screenStream) {
        for (const t of this.screenStream.getTracks()) pc.addTrack(t, this.screenStream);
        await this.sendOffer(peerId);
      }
    }
    return this.screenStream;
  }

  async stopScreenShare(): Promise<void> {
    if (!this.screenStream) return;
    const tracks = this.screenStream.getTracks();
    for (const t of tracks) t.stop();
    for (const peerId of [...this.pcs.keys()]) {
      const pc = this.pcs.get(peerId);
      if (!pc) continue;
      for (const sender of pc.getSenders()) {
        if (sender.track && tracks.includes(sender.track)) pc.removeTrack(sender);
      }
      await this.sendOffer(peerId);
    }
    this.screenStream = null;
  }

  startRecording(onBlob: (blob: Blob) => void): void {
    if (this.recorder) return;
    this.recordCtx = new AudioContext();
    void this.recordCtx.resume();
    this.recordDest = this.recordCtx.createMediaStreamDestination();
    if (this.localStream) {
      this.recordCtx.createMediaStreamSource(this.localStream).connect(this.recordDest);
    }
    for (const stream of this.remoteStreams.values()) {
      this.recordCtx.createMediaStreamSource(stream).connect(this.recordDest);
    }
    this.recorder = new MediaRecorder(this.recordDest.stream, { mimeType: 'audio/webm' });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.recordedChunks.push(e.data);
    };
    this.recorder.onstop = () => {
      onBlob(new Blob(this.recordedChunks, { type: 'audio/webm' }));
      this.recordedChunks = [];
    };
    this.recorder.start(1000);
  }

  stopRecording(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorder = null;
    void this.recordCtx?.close();
    this.recordCtx = null;
    this.recordDest = null;
  }

  isRecording(): boolean {
    return this.recorder !== null && this.recorder.state !== 'inactive';
  }

  leave(): void {
    this.stopRecording();
    for (const t of this.localStream?.getTracks() ?? []) t.stop();
    for (const t of this.screenStream?.getTracks() ?? []) t.stop();
    for (const t of this.videoStream?.getTracks() ?? []) t.stop();
    for (const pc of this.pcs.values()) pc.close();
    this.pcs.clear();
    this.remoteStreams.clear();
    this.localStream = null;
    this.videoStream = null;
    this.screenStream = null;
  }
}
