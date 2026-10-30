import { Router } from 'express';
import { classifyGeminiError, type GeminiRiskAnalyzer } from './ai.js';
import { actorIdFor } from './authentication.js';

export function createAiRouter(analyzer: GeminiRiskAnalyzer): Router {
  const router = Router();
  router.get('/status', (_request, response) => response.json({
    available: analyzer.available,
    provider: 'Google Gemini',
    model: analyzer.available ? analyzer.model : null,
    missingVariableNames: analyzer.available ? [] : ['GEMINI_API_KEY'],
    configurationError: analyzer.configurationError,
  }));
  router.post('/analyze', async (request, response) => {
    const { operation } = request.body ?? {};
    const actorId = actorIdFor(request);
    if (typeof operation !== 'string' || operation.trim().length < 5 || operation.length > 2000) {
      return response.status(400).json({ error: 'A 5–2000 character operation description is required' });
    }
    try {
      response.json(await analyzer.analyze(actorId, operation.trim()));
    } catch (error) {
      const { failure } = classifyGeminiError(error);
      console.error(JSON.stringify({
        event: 'gemini_analysis_failure',
        code: failure.code,
        httpStatus: failure.status,
        ...(failure.providerStatus ? { providerStatus: failure.providerStatus } : {}),
        model: analyzer.model,
        errorType: error instanceof Error && error.name === 'ApiError' ? 'ApiError' : error instanceof Error ? 'Error' : 'UnknownError',
      }));
      response.status(failure.status).json({ error: failure.message, code: failure.code });
    }
  });
  return router;
}