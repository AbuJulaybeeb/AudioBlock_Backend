import { routeParam } from '../routeParams';

describe('routeParam', () => {
  describe('string values', () => {
    it('returns the string unchanged when given a plain string', () => {
      expect(routeParam('abc-123')).toBe('abc-123');
    });

    it('returns a valid UUID unchanged', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      expect(routeParam(uuid)).toBe(uuid);
    });

    it('returns a numeric string unchanged', () => {
      expect(routeParam('42')).toBe('42');
    });

    it('returns an empty string when given an empty string', () => {
      expect(routeParam('')).toBe('');
    });
  });

  describe('undefined values (missing params)', () => {
    it('returns an empty string when the param is undefined', () => {
      expect(routeParam(undefined)).toBe('');
    });
  });

  describe('array values (Express 5 duplicate-param behaviour)', () => {
    it('returns the first element when Express supplies an array', () => {
      expect(routeParam(['first', 'second'])).toBe('first');
    });

    it('returns the first element of a single-element array', () => {
      expect(routeParam(['only'])).toBe('only');
    });

    it('returns an empty string for an empty array', () => {
      expect(routeParam([])).toBe('');
    });

    it('returns the first UUID in an array of UUIDs', () => {
      const id1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const id2 = '11111111-2222-3333-4444-555555555555';
      expect(routeParam([id1, id2])).toBe(id1);
    });
  });
});
