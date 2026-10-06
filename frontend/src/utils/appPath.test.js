import { describe, it, expect, afterEach, vi } from 'vitest';
import { appPath, isAtAppPath } from './appPath';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('appPath', () => {
  it.each([
    ['/BizOS/', '/login', '/BizOS/login'],
    ['/BizOS/', 'login', '/BizOS/login'],
    ['/BizOS/', '/portal/login', '/BizOS/portal/login'],
    ['/BizOS/', '/', '/BizOS/'],
    ['/BizOS', '/login', '/BizOS/login'],
    ['/', '/login', '/login'],
    ['/other/base/', '/login', '/other/base/login'],
  ])('with BASE_URL %s, appPath(%s) is %s', (base, path, expected) => {
    vi.stubEnv('BASE_URL', base);
    expect(appPath(path)).toBe(expected);
  });

  it('follows the configured BASE_URL rather than a hardcoded /BizOS/', () => {
    vi.stubEnv('BASE_URL', '/Other/');
    expect(appPath('/login')).toBe('/Other/login');
  });
});

describe('isAtAppPath', () => {
  it('is true only for the in-app path, not the bare path outside the base', () => {
    vi.stubEnv('BASE_URL', '/BizOS/');
    vi.stubGlobal('location', { pathname: '/BizOS/login' });
    expect(isAtAppPath('/login')).toBe(true);
    vi.stubGlobal('location', { pathname: '/BizOS/pos' });
    expect(isAtAppPath('/login')).toBe(false);
    vi.stubGlobal('location', { pathname: '/login' });
    expect(isAtAppPath('/login')).toBe(false);
  });
});
