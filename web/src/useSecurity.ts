import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { SecurityPolicy, SecurityReview, SecurityState } from './types';
import type { ChatSocket } from './ws';

export default function useSecurity(socket: ChatSocket | null, online: boolean) {
  const [state, setState] = useState<SecurityState>();
  const [reviews, setReviews] = useState<SecurityReview[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController>();
  const generation = useRef(0);

  const load = useCallback(async () => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    const version = generation.current;
    try {
      const result = await api.security.get(request.signal);
      if (request.signal.aborted) return;
      setState(result);
      if (version === generation.current) setReviews(result.reviews);
    } catch {
      if (!request.signal.aborted) setError('Impossible de vérifier la protection MaelGard.');
    }
  }, []);

  useEffect(() => {
    void load();
    return () => pending.current?.abort();
  }, [load, online]);

  useEffect(() => socket?.onMessage((event) => {
    if (event.type === 'securityReview' && event.review) {
      generation.current++;
      const review = event.review;
      setReviews((current) => current.some((item) => item.id === review.id) ? current : [...current, review]);
    } else if (event.type === 'securityReviewClosed') {
      generation.current++;
      setReviews((current) => current.filter((item) => item.id !== event.reviewId));
    } else if (event.type === 'securityPolicyChanged') void load();
  }), [load, socket]);

  async function save(policy: SecurityPolicy): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.security.save(policy);
      setState((current) => current && { ...current, policy: result.policy });
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Impossible d’enregistrer la politique.');
      await load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function decide(action: 'cancel' | 'anonymize') {
    const review = reviews[0];
    if (!review || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.security.decide(review.id, action);
      setReviews((current) => current.filter((item) => item.id !== review.id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Impossible de confirmer la décision.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    setBusy(true);
    setError(undefined);
    try {
      const { health } = await api.security.check();
      setState((current) => current && { ...current, health });
    } catch {
      setError('Impossible de joindre le service local MaelGard.');
    } finally {
      setBusy(false);
    }
  }

  return { state, review: reviews[0], error, busy, save, decide, check };
}
