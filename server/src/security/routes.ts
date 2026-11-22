import type { Router } from 'express';
import { z } from 'zod';
import type { AIGuard } from './ai-guard.js';
import type { SecurityStore } from './security-store.js';

export function mountSecurity(app: Router, store: SecurityStore, guard: AIGuard, changed: () => void, maskingChanged: (userId: number) => void) {
  app.get('/api/security', async (req, res) => {
    res.json({ policy: store.policy(), health: await guard.status(), reviews: guard.list(req.user!.id), remembered: store.remembered(req.user!.id).size });
  });

  app.post('/api/security/check', async (_req, res) => {
    res.json({ health: await guard.checkHealth() });
  });

  const policyInput = z.object({
    detection: z.enum(['block', 'anonymize', 'ask']),
    modelErrors: z.enum(['fail-closed', 'fail-open']),
    version: z.number().int().positive().safe(),
  }).strict();
  app.put('/api/security/policy', (req, res) => {
    if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') {
      res.status(403).json({ error: 'Réservé aux administrateurs du salon.' });
      return;
    }
    const parsed = policyInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Politique de sécurité invalide.' }); return; }
    if (!store.update(parsed.data)) { res.status(409).json({ error: 'La politique a changé. Recharge les réglages.' }); return; }
    guard.cancelAll();
    changed();
    res.json({ policy: store.policy() });
  });

  app.delete('/api/security/masking', (req, res) => {
    store.forget(req.user!.id);
    maskingChanged(req.user!.id);
    res.status(204).end();
  });

  const decision = z.object({ action: z.enum(['cancel', 'anonymize']), remember: z.boolean().default(false) })
    .strict().refine((value) => !value.remember || value.action === 'anonymize');
  app.post('/api/security/reviews/:id', (req, res) => {
    const parsed = decision.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Décision invalide.' }); return; }
    if (!guard.decide(req.user!.id, String(req.params.id), parsed.data.action, parsed.data.remember)) {
      res.status(409).json({ error: 'Cette demande a été traitée, annulée ou a expiré.' });
      return;
    }
    res.status(204).end();
  });
}
