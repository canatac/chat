import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '../llm/providers.js';
import { detectionMetadata, LinGuardClient, LinGuardError, maskText, type DetectionMetadata, type ModelErrorPolicy } from './linguard-client.js';
import type { SecurityStore } from './security-store.js';

export type AnalyzerFactory = (policy: ModelErrorPolicy) => Pick<LinGuardClient, 'health' | 'analyze'>;

export interface SecurityReview extends DetectionMetadata {
  id: string;
  expiresAt: number;
  policyVersion: number;
}

interface Pending {
  userId: number;
  review: SecurityReview;
  masked: ChatMessage[];
  timer: NodeJS.Timeout;
  resolve: (messages: ChatMessage[]) => void;
  reject: (error: Error) => void;
}

export class SecurityBlocked extends Error {
  constructor(message = 'La politique MaelGard a bloqué l’envoi à l’IA.') {
    super(message);
    this.name = 'SecurityBlocked';
  }
}

const empty: DetectionMetadata = { types: [], count: 0, maxScore: null };

export class AIGuard {
  private readonly pending = new Map<string, Pending>();
  private readonly active = new Set<Promise<ChatMessage[]>>();
  private closed = false;
  private availability = { available: false, error: 'Vérification du service local MaelGard en cours.' as string | null };
  private readonly startup: Promise<void>;

  constructor(
    private readonly store: SecurityStore,
    private readonly notify: (userId: number, payload: unknown) => void,
    private readonly makeClient: AnalyzerFactory = (policy) => new LinGuardClient(5000, policy),
    private readonly authorized: (userId: number) => boolean = () => true,
  ) {
    this.startup = this.checkHealth().then(() => {});
  }

  async checkHealth() {
    try {
      await this.makeClient('fail-closed').health();
      this.availability = { available: true, error: null };
    } catch {
      this.availability = { available: false, error: 'Le service local MaelGard LinGuard est indisponible. Envoi à l’IA bloqué.' };
    }
    return this.availability;
  }

  async status() {
    await this.startup;
    return this.availability;
  }

  list(userId: number): SecurityReview[] {
    return [...this.pending.values()].filter((item) => item.userId === userId).map((item) => item.review);
  }

  protect(messages: ChatMessage[], userId?: number): Promise<ChatMessage[]> {
    if (this.closed) return Promise.reject(new SecurityBlocked());
    const task = this.review(messages, userId);
    this.active.add(task);
    void task.finally(() => this.active.delete(task)).catch(() => {});
    return task;
  }

  private async review(messages: ChatMessage[], userId?: number): Promise<ChatMessage[]> {
    if (userId === undefined || !this.authorized(userId)) throw new SecurityBlocked('L’accès au salon a changé. Envoi à l’IA bloqué.');
    const policy = this.store.policy();
    let analysis;
    try {
      analysis = await this.makeClient(policy.modelErrors).analyze(messages.map((message) => message.content));
      this.availability = { available: true, error: null };
    } catch (error) {
      const metadata = error instanceof LinGuardError ? error.metadata ?? empty : empty;
      this.store.audit(userId, 'blocked-analysis', metadata);
      this.availability = { available: false, error: error instanceof LinGuardError ? error.message : 'Analyse MaelGard indisponible. Envoi à l’IA bloqué.' };
      throw new SecurityBlocked(this.availability.error!);
    }
    const metadata = detectionMetadata(analysis.texts);
    if (analysis.model_errors.length) {
      this.store.audit(userId, 'model-errors-' + policy.modelErrors, metadata);
      if (policy.modelErrors === 'fail-closed') throw new SecurityBlocked();
    }
    if (this.closed || !this.authorized(userId) || this.store.policy().version !== policy.version) throw new SecurityBlocked('La politique MaelGard ou l’accès au salon a changé. Relance la demande.');
    if (!metadata.count) {
      this.store.audit(userId, 'allowed', metadata);
      return messages;
    }
    if (policy.detection === 'block') {
      this.store.audit(userId, 'blocked-pii', metadata);
      throw new SecurityBlocked('Des données personnelles ont été détectées. La politique MaelGard bloque l’envoi à l’IA.');
    }
    const masked = messages.map((message, index) => ({ ...message, content: maskText(message.content, analysis.texts[index]) }));
    if (policy.detection === 'anonymize') {
      this.store.audit(userId, 'anonymized', metadata);
      return masked;
    }
    return new Promise((resolve, reject) => {
      const review: SecurityReview = { id: randomUUID(), expiresAt: Date.now() + 120_000, policyVersion: policy.version, ...metadata };
      const timer = setTimeout(() => this.cancel(review.id, 'expired'), 120_000);
      timer.unref();
      this.pending.set(review.id, { userId, review, masked, timer, resolve, reject });
      this.store.audit(userId, 'awaiting-user', metadata);
      this.notify(userId, { type: 'securityReview', review });
    });
  }

  decide(userId: number, id: string, action: 'cancel' | 'anonymize'): boolean {
    const item = this.pending.get(id);
    if (!item || item.userId !== userId) return false;
    if (!this.authorized(userId) || item.review.expiresAt <= Date.now() || item.review.policyVersion !== this.store.policy().version) {
      this.cancel(id, 'expired');
      return false;
    }
    if (action === 'cancel') this.cancel(id, 'cancelled');
    else {
      this.pending.delete(id);
      clearTimeout(item.timer);
      this.store.audit(userId, 'anonymized-user', item.review);
      this.notify(userId, { type: 'securityReviewClosed', reviewId: id });
      item.resolve(item.masked);
    }
    return true;
  }

  cancelAll(): void {
    for (const id of this.pending.keys()) this.cancel(id, 'cancelled');
  }

  cancelUser(userId: number): void {
    for (const [id, item] of this.pending) {
      if (item.userId === userId) this.cancel(id, 'cancelled');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelAll();
    await Promise.allSettled(this.active);
  }

  private cancel(id: string, reason: string): void {
    const item = this.pending.get(id);
    if (!item) return;
    this.pending.delete(id);
    clearTimeout(item.timer);
    this.store.audit(item.userId, reason, item.review);
    this.notify(item.userId, { type: 'securityReviewClosed', reviewId: id });
    item.reject(new SecurityBlocked('La demande IA a été annulée ou a expiré. Aucun texte n’a été envoyé à l’IA.'));
  }
}
