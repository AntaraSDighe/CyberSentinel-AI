import express from 'express';
import type { RequestHandler } from 'express';

export function createFrontendHandler(directory: string): RequestHandler {
  const staticAssets = express.static(directory, { index: false });
  return (request, response, next) => {
    if (request.path === '/api' || request.path.startsWith('/api/') || request.method !== 'GET') {
      next();
      return;
    }

    staticAssets(request, response, (error) => {
      if (error) {
        next(error);
        return;
      }
      if (!request.accepts('html')) {
        next();
        return;
      }
      response.sendFile('index.html', { root: directory }, (sendError) => {
        if (sendError) next(sendError);
      });
    });
  };
}
