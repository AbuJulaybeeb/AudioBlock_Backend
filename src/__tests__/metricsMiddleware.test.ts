import express, { Request, Response } from 'express';
import request from 'supertest';
import { metricsMiddleware } from '../middlewares/metricsMiddleware';
import { httpRequestsTotal } from '../services/MetricsService';

describe('metricsMiddleware (#827)', () => {
  let app: express.Express;

  beforeEach(() => {
    httpRequestsTotal.reset();
    app = express();
    app.use(metricsMiddleware);

    const songRouter = express.Router();
    songRouter.get('/:id', (req: Request, res: Response) => {
      res.json({ id: req.params.id });
    });

    app.use('/api/song', songRouter);
  });

  it('bounds route label cardinality when hitting different UUIDs and unknown URLs', async () => {
    const uuid1 = '11111111-1111-1111-1111-111111111111';
    const uuid2 = '22222222-2222-2222-2222-222222222222';

    await request(app).get(`/api/song/${uuid1}`);
    await request(app).get(`/api/song/${uuid2}`);
    await request(app).get('/unknown/random/scanner-path');

    const metric = await httpRequestsTotal.get();
    const routeLabels = Array.from(new Set(metric.values.map((v) => v.labels.route)));

    expect(routeLabels).toHaveLength(2);
    expect(routeLabels).toContain('/api/song/:id');
    expect(routeLabels).toContain('unmatched');
  });
});
