import 'reflect-metadata';

jest.mock('../config/db', () => ({
  __esModule: true,
  default: { query: jest.fn(), driver: {} },
}));
jest.mock('../config/redis', () => ({
  __esModule: true,
  default: { ping: jest.fn(), get: jest.fn(), set: jest.fn(), on: jest.fn() },
}));

import healthRoutes from '../routes/healthRoutes';

describe('healthRoutes', () => {
  const routeLayer = (path: string) =>
    (healthRoutes as any).stack.find((layer: any) => layer.route?.path === path);

  it('exposes /live, /ready, /detailed and /worker', () => {
    expect(routeLayer('/live')).toBeDefined();
    expect(routeLayer('/ready')).toBeDefined();
    expect(routeLayer('/detailed')).toBeDefined();
    expect(routeLayer('/worker')).toBeDefined();
  });

  it('gates /detailed behind an auth/role-check middleware before the controller', () => {
    const layer = routeLayer('/detailed');
    // requireRoles(ADMIN) + HealthController.detailed => two stacked handlers.
    expect(layer.route.stack.length).toBe(2);
  });

  it('does not gate /live, /ready, or /worker behind extra middleware', () => {
    expect(routeLayer('/live').route.stack.length).toBe(1);
    expect(routeLayer('/ready').route.stack.length).toBe(1);
    expect(routeLayer('/worker').route.stack.length).toBe(1);
  });
});
