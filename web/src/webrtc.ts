import { api } from './api';
import type { ChatSocket } from './ws';

export interface CallSessionHandlers {
  onAudioTrack: (peerId: number, track: MediaStreamTrack, stream: MediaStream) => void;
  onVideoTrack: (peerId: number, track: MediaStreamTrack, stream: MediaStream) => void;
  onPeerRemoved: (peerId: number) => void;
  onPeerState: (peerId: number, state: string) => void;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
let iceServersCache: RTCIceServer[] | null = null;

export async function loadIceServers(): Promise<RTCIceServer[]> {
  if (iceServersCache) return iceServersCache;
  try {
    const cfg = await api.rtcConfig();
    iceServersCache = cfg.iceServers?.length ? cfg.iceServers : DEFAULT_ICE_SERVERS;
  } catch {
    iceServersCache = DEFAULT_ICE_SERVERS;
  }
  return iceServersCache;
}

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  remoteSet: boolean;
  audioStream: MediaStream;
  videoTracks: Set<MediaStreamTrack>;
  iceRestarted: boolean;
  disconnectTimer: number | null;
}

export class CallSession {
  private peers = new Map<number, Peer>();
  private localStream: MediaStream | null = null;
  private videoStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private readonly ws: ChatSocket;
  private readonly userId: number;
  private callId = 0;
  private readonly handlers: CallSessionHandlers;
  private unlockCtx: AudioContext | null = null;
  private recorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private recordCtx: AudioContext | null = null;
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  private mixSources = new Map<MediaStreamTrack, MediaStreamAudioSourceNode>();
  private lastMimeType = '';
  private onStopCallback: ((blob: Blob) => void) | null = null;

  constructor(ws: ChatSocket, userId: number, callId: number, handlers: CallSessionHandlers) {
    this.ws = ws;
    this.userId = userId;
    this.callId = callId;
    this.handlers = handlers;
  }

  setCallId(callId: number): void {
    this.callId = callId;
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

  async acquireLocalMedia(): Promise<MediaStream> {
    this.unlockAudio();
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return this.localStream;
  }

  attachLocalStream(stream: MediaStream): void {
    this.unlockAudio();
    this.localStream = stream;
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

  hasPeer(peerId: number): boolean {
    return this.peers.has(peerId);
  }

  private sendSignal(peerId: number, data: unknown): void {
    this.ws.sendRaw({ type: 'signal', to: peerId, callId: this.callId, data });
  }

  private createPeer(peerId: number): Peer {
    const pc = new RTCPeerConnection({ iceServers: iceServersCache ?? DEFAULT_ICE_SERVERS });
    const peer: Peer = {
      pc,
      polite: this.userId < peerId,
      makingOffer: false,
      ignoreOffer: false,
      pendingCandidates: [],
      remoteSet: false,
      audioStream: new MediaStream(),
      videoTracks: new Set(),
      iceRestarted: false,
      disconnectTimer: null,
    };
    this.peers.set(peerId, peer);
    if (this.localStream) for (const t of this.localStream.getTracks()) pc.addTrack(t, this.localStream);
    if (this.videoStream) for (const t of this.videoStream.getTracks()) pc.addTrack(t, this.videoStream);
    if (this.screenStream) for (const t of this.screenStream.getTracks()) pc.addTrack(t, this.screenStream);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.sendSignal(peerId, { sdp: pc.localDescription });
      } catch (err) {
        console.error('negotiationneeded', err);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.sendSignal(peerId, { candidate: ev.candidate.toJSON() });
    };
    pc.ontrack = (ev) => this.onTrack(peerId, ev);
    pc.onconnectionstatechange = () => this.onConnState(peerId);
    return peer;
  }

  private onTrack(peerId: number, ev: RTCTrackEvent): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const track = ev.track;
    this.unlockAudio();
    track.onended = () => {
      if (track.kind === 'audio') {
        peer.audioStream.removeTrack(track);
        this.detachFromMix(track);
      } else {
        peer.videoTracks.delete(track);
      }
    };
    if (track.kind === 'audio') {
      if (!peer.audioStream.getTracks().includes(track)) peer.audioStream.addTrack(track);
      if (this.isRecording()) this.attachToMix(track);
      this.handlers.onAudioTrack(peerId, track, peer.audioStream);
    } else if (track.kind === 'video') {
      peer.videoTracks.add(track);
      this.handlers.onVideoTrack(peerId, track, ev.streams[0]);
    }
  }

  private onConnState(peerId: number): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const st = peer.pc.connectionState;
    this.handlers.onPeerState(peerId, st);
    if (st === 'disconnected') {
      if (peer.disconnectTimer) clearTimeout(peer.disconnectTimer);
      peer.disconnectTimer = window.setTimeout(() => {
        if (peer.pc.connectionState === 'disconnected' && !peer.iceRestarted) {
          peer.iceRestarted = true;
          try {
            peer.pc.restartIce();
          } catch {
            // ignore
          }
        }
      }, 8000);
      return;
    }
    if (peer.disconnectTimer) {
      clearTimeout(peer.disconnectTimer);
      peer.disconnectTimer = null;
    }
    if (st === 'connected') peer.iceRestarted = false;
    if (st === 'failed') {
      if (!peer.iceRestarted) {
        peer.iceRestarted = true;
        try {
          peer.pc.restartIce();
        } catch {
          // ignore
        }
      } else {
        this.removePeer(peerId);
      }
    }
    if (st === 'closed') this.removePeer(peerId);
  }

  private removePeer(peerId: number): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (peer.disconnectTimer) clearTimeout(peer.disconnectTimer);
    for (const t of peer.audioStream.getTracks()) this.detachFromMix(t);
    try {
      peer.pc.close();
    } catch {
      // ignore
    }
    this.peers.delete(peerId);
    this.handlers.onPeerRemoved(peerId);
  }

  async connectTo(peerId: number): Promise<void> {
    if (peerId === this.userId || this.peers.has(peerId)) return;
    this.createPeer(peerId);
    await this.renegotiate(peerId);
  }

  private async renegotiate(peerId: number): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer || peer.makingOffer) return;
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription();
      this.sendSignal(peerId, { sdp: peer.pc.localDescription });
    } catch (err) {
      console.error('renegotiate', err);
    } finally {
      peer.makingOffer = false;
    }
  }

  async handleSignal(from: number, data: unknown): Promise<void> {
    if (from === this.userId) return;
    const peer = this.peers.get(from) ?? this.createPeer(from);
    const pc = peer.pc;
    const d = data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
    try {
      if (d.sdp) {
        const offerCollision = d.sdp.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(d.sdp);
        peer.remoteSet = true;
        for (const c of peer.pendingCandidates.splice(0)) {
          try {
            await pc.addIceCandidate(c);
          } catch {
            // ignore
          }
        }
        if (d.sdp.type === 'offer') {
          await pc.setLocalDescription();
          this.sendSignal(from, { sdp: pc.localDescription });
        }
      } else if (d.candidate) {
        if (!peer.remoteSet) {
          peer.pendingCandidates.push(d.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(d.candidate);
        } catch {
          // ignore
        }
      }
    } catch (err) {
      console.error('handleSignal', err);
    }
  }

  setMuted(muted: boolean): void {
    this.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }

  async startCamera(): Promise<MediaStream> {
    this.videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const track = this.videoStream.getVideoTracks()[0];
    for (const peerId of [...this.peers.keys()]) {
      const peer = this.peers.get(peerId);
      if (peer && this.videoStream) {
        peer.pc.addTrack(track, this.videoStream);
        await this.renegotiate(peerId);
      }
    }
    return this.videoStream;
  }

  async stopCamera(): Promise<void> {
    if (!this.videoStream) return;
    const tracks = this.videoStream.getTracks();
    for (const t of tracks) t.stop();
    for (const peerId of [...this.peers.keys()]) {
      const peer = this.peers.get(peerId);
      if (!peer) continue;
      for (const sender of peer.pc.getSenders()) {
        if (sender.track && tracks.includes(sender.track)) peer.pc.removeTrack(sender);
      }
      await this.renegotiate(peerId);
    }
    this.videoStream = null;
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
    for (const peerId of [...this.peers.keys()]) {
      const peer = this.peers.get(peerId);
      if (peer && this.screenStream) {
        for (const t of this.screenStream.getTracks()) peer.pc.addTrack(t, this.screenStream);
        await this.renegotiate(peerId);
      }
    }
    return this.screenStream;
  }

  async stopScreenShare(): Promise<void> {
    if (!this.screenStream) return;
    const tracks = this.screenStream.getTracks();
    for (const t of tracks) t.stop();
    for (const peerId of [...this.peers.keys()]) {
      const peer = this.peers.get(peerId);
      if (!peer) continue;
      for (const sender of peer.pc.getSenders()) {
        if (sender.track && tracks.includes(sender.track)) peer.pc.removeTrack(sender);
      }
      await this.renegotiate(peerId);
    }
    this.screenStream = null;
  }

  private pickRecorderMimeType(): string {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
    for (const c of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(c)) return c;
      } catch {
        // ignore
      }
    }
    return '';
  }

  recorderMimeType(): string {
    return this.lastMimeType;
  }

  recordingExtension(): string {
    if (this.lastMimeType.includes('mp4')) return 'm4a';
    if (this.lastMimeType.includes('ogg')) return 'ogg';
    return 'webm';
  }

  private attachToMix(track: MediaStreamTrack): void {
    if (!this.recordCtx || !this.recordDest || this.mixSources.has(track)) return;
    try {
      const src = this.recordCtx.createMediaStreamSource(new MediaStream([track]));
      src.connect(this.recordDest);
      this.mixSources.set(track, src);
    } catch {
      // ignore
    }
  }

  private detachFromMix(track: MediaStreamTrack): void {
    const src = this.mixSources.get(track);
    if (src) {
      try {
        src.disconnect();
      } catch {
        // ignore
      }
      this.mixSources.delete(track);
    }
  }

  startRecording(onBlob: (blob: Blob) => void): void {
    if (this.recorder) return;
    this.lastMimeType = this.pickRecorderMimeType();
    if (!this.lastMimeType && typeof MediaRecorder !== 'undefined') {
      try {
        new MediaRecorder(new MediaStream());
      } catch {
        // non supporté
      }
    }
    this.recordCtx = new AudioContext();
    void this.recordCtx.resume();
    this.recordDest = this.recordCtx.createMediaStreamDestination();
    for (const t of this.localStream?.getAudioTracks() ?? []) this.attachToMix(t);
    for (const peer of this.peers.values()) {
      for (const t of peer.audioStream.getAudioTracks()) this.attachToMix(t);
    }
    this.recorder = new MediaRecorder(this.recordDest.stream, this.lastMimeType ? { mimeType: this.lastMimeType } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.recordedChunks.push(e.data);
    };
    this.onStopCallback = onBlob;
    this.recorder.onstop = () => {
      const cb = this.onStopCallback;
      this.onStopCallback = null;
      const blob = new Blob(this.recordedChunks, { type: this.lastMimeType || 'audio/webm' });
      this.recordedChunks = [];
      this.recorder = null;
      for (const t of this.mixSources.keys()) this.detachFromMix(t);
      void this.recordCtx?.close();
      this.recordCtx = null;
      this.recordDest = null;
      if (cb) cb(blob);
    };
    this.recorder.start(1000);
  }

  stopRecordingWith(onBlob: (blob: Blob) => void): void {
    this.onStopCallback = onBlob;
    this.stopRecording();
  }

  stopRecording(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorder = null;
  }

  isRecording(): boolean {
    return this.recorder !== null && this.recorder.state !== 'inactive';
  }

  leave(): void {
    this.stopRecording();
    for (const t of this.localStream?.getTracks() ?? []) t.stop();
    for (const t of this.screenStream?.getTracks() ?? []) t.stop();
    for (const t of this.videoStream?.getTracks() ?? []) t.stop();
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    this.localStream = null;
    this.videoStream = null;
    this.screenStream = null;
  }
}
