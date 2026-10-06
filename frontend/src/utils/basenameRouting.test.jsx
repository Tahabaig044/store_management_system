import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { appPath } from './appPath';

// Root cause of the blank page after a 401: the router only knows paths under its basename.
function Harness() {
  return (
    <BrowserRouter basename="/BizOS/">
      <Routes>
        <Route path="/login" element={<div>login page</div>} />
        <Route path="/portal/login" element={<div>portal login page</div>} />
      </Routes>
    </BrowserRouter>
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.pushState({}, '', '/');
});

describe('login redirect targets resolve inside the router basename', () => {
  it('the path produced by appPath("/login") renders the login page', () => {
    vi.stubEnv('BASE_URL', '/BizOS/');
    window.history.pushState({}, '', appPath('/login'));
    render(<Harness />);
    expect(screen.getByText('login page')).toBeInTheDocument();
  });

  it('the path produced by appPath("/portal/login") renders the portal login page', () => {
    vi.stubEnv('BASE_URL', '/BizOS/');
    window.history.pushState({}, '', appPath('/portal/login'));
    render(<Harness />);
    expect(screen.getByText('portal login page')).toBeInTheDocument();
  });

  it('a bare /login (the old redirect target) matches nothing - the blank page', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.history.pushState({}, '', '/login');
    const { container } = render(<Harness />);
    expect(container).toBeEmptyDOMElement();
    warn.mockRestore();
  });
});
