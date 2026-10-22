import { Router } from 'express';
import type { GeminiRiskAnalyzer } from './ai.js';
import { sendApiError } from './errors.js';

const identifierPattern = /^[a-zA-Z0-9._:-]{1,128}$/;

export function createAiRouter(analyzer: GeminiRiskAnalyzer): Router {
  const router = Router();
  router.get('/status', (_request, response) => response.json({ available: analyzer.available, provider: 'Google Gemini', model: analyzer.available ? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash' : null }));
  router.post('/analyze', async (request, response) => {
    const { actorId, operation } = request.body ?? {};
    if (typeof actorId !== 'string' || !identifierPattern.test(actorId) || typeof operation !== 'string' || operation.trim().length < 5 || operation.length > 2000) {
      return response.status(400).json({ error: 'actorId and a 5–2000 character operation description are required' });
    }
    try {
      response.json(await analyzer.analyze(actorId, operation.trim()));
    } catch (error) {
      sendApiError(response, error, 'ai.analyze', analyzer.available ? 502 : 503, 'Gemini analysis failed');
    }
  });
  return router;
}