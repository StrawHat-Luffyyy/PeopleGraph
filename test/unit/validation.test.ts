import { describe, expect, it } from 'vitest';
import { parseCreateUser, parseUserId } from '../../src/api/validation.js';
import { ValidationError } from '../../src/shared/errors.js';

describe('parseUserId', () => {
  it.each(['u1', 'abc_DEF-123', 'a'.repeat(64), '550e8400-e29b-41d4-a716-446655440000'])(
    'accepts %j',
    (id) => {
      expect(parseUserId(id)).toBe(id);
    },
  );

  it.each(['', 'a'.repeat(65), 'has space', 'semi;colon', "quote'", 'ünï', undefined, 42])(
    'rejects %j',
    (id) => {
      expect(() => parseUserId(id)).toThrow(ValidationError);
    },
  );
});

describe('parseCreateUser', () => {
  it('accepts a valid body and trims the name', () => {
    expect(parseCreateUser({ id: 'u1', handle: 'ana_k', name: '  Ana K  ' })).toEqual({
      id: 'u1',
      handle: 'ana_k',
      name: 'Ana K',
    });
  });

  it('lowercases the handle so uniqueness is case-insensitive', () => {
    expect(parseCreateUser({ id: 'u1', handle: 'Ana_K', name: 'Ana' }).handle).toBe('ana_k');
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['missing id', { handle: 'ana', name: 'Ana' }],
    ['bad id', { id: 'a b', handle: 'ana', name: 'Ana' }],
    ['missing handle', { id: 'u1', name: 'Ana' }],
    ['handle too short', { id: 'u1', handle: 'ab', name: 'Ana' }],
    ['handle too long', { id: 'u1', handle: 'a'.repeat(31), name: 'Ana' }],
    ['handle with dash', { id: 'u1', handle: 'ana-k', name: 'Ana' }],
    ['missing name', { id: 'u1', handle: 'ana' }],
    ['blank name', { id: 'u1', handle: 'ana', name: '   ' }],
    ['name too long', { id: 'u1', handle: 'ana', name: 'x'.repeat(101) }],
    ['nested name', { id: 'u1', handle: 'ana', name: { first: 'Ana' } }],
  ])('rejects %s', (_label, body) => {
    expect(() => parseCreateUser(body)).toThrow(ValidationError);
  });

  it('never echoes the submitted name in the error (PII)', () => {
    try {
      parseCreateUser({ id: 'u1', handle: 'a', name: 'Secret Person' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('Secret Person');
    }
  });
});
