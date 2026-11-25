import express from 'express';
import path from 'node:path';

export function createTileRouter(config) {
  const router = express.Router();
  const root = config.tilesDir || path.join(path.dirname(config.databasePath), 'tiles');
  router.use((req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, If-None-Match, If-Modified-Since, If-Range',
      'Access-Control-Expose-Headers': 'ETag, Content-Range, Accept-Ranges, Content-Length, Last-Modified',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.set('Allow', 'GET, HEAD, OPTIONS');
      return res.sendStatus(405);
    }
    next();
  });
  router.get('/via-ferrata.pmtiles', (req, res, next) => {
    res.type('application/vnd.pmtiles');
    // Express streams the selected range and handles HEAD, validators and 416.
    res.sendFile('via-ferrata.pmtiles', { root, maxAge: '1h' }, (error) => {
      if (!error) return;
      if (res.headersSent) return next(error);
      if (error.status === 416) {
        res.set(error.headers);
        return res.status(416).end();
      }
      if (error.code === 'ENOENT') return res.sendStatus(404);
      next(error);
    });
  });
  router.use((req, res) => res.sendStatus(404));
  return router;
}
