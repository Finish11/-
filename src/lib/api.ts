const TOKEN_KEY = 'pulsenet_auth_token';
const EXPLICIT_LOGOUT_KEY = 'pulsenet_explicit_logout';

let memoryToken: string | null = null;
let memoryExplicitLogout = false;

function readWindowNameState(): Record<string, string> {
  try {
    if (typeof window !== 'undefined' && window.name && window.name.startsWith('__pn:')) {
      return JSON.parse(window.name.slice(5)) as Record<string, string>;
    }
  } catch {
    // ignore
  }
  return {};
}

function writeWindowNameState(patch: Record<string, string | null>): void {
  try {
    if (typeof window === 'undefined') return;
    const current = readWindowNameState();
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete current[k];
      else current[k] = v;
    }
    window.name = '__pn:' + JSON.stringify(current);
  } catch {
    // ignore
  }
}

export function getStoredToken(): string | null {
  if (memoryToken) return memoryToken;

  try {
    const ls = localStorage.getItem(TOKEN_KEY);
    if (ls) {
      memoryToken = ls;
      return ls;
    }
  } catch {
    // localStorage may be blocked in strict third-party iframe
  }

  try {
    const ss = sessionStorage.getItem(TOKEN_KEY);
    if (ss) {
      memoryToken = ss;
      return ss;
    }
  } catch {
    // ignore
  }

  const wn = readWindowNameState()[TOKEN_KEY];
  if (wn) {
    memoryToken = wn;
    return wn;
  }

  return null;
}

export function setStoredToken(token: string | null): void {
  memoryToken = token;
  if (token) {
    memoryExplicitLogout = false;
  }

  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.removeItem(EXPLICIT_LOGOUT_KEY);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // ignore
  }

  try {
    if (token) {
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.removeItem(EXPLICIT_LOGOUT_KEY);
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // ignore
  }

  writeWindowNameState({
    [TOKEN_KEY]: token,
    ...(token ? { [EXPLICIT_LOGOUT_KEY]: null } : {}),
  });
}

export function markExplicitLogout(): void {
  memoryToken = null;
  memoryExplicitLogout = true;

  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.setItem(EXPLICIT_LOGOUT_KEY, '1');
  } catch {
    // ignore
  }

  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.setItem(EXPLICIT_LOGOUT_KEY, '1');
  } catch {
    // ignore
  }

  writeWindowNameState({
    [TOKEN_KEY]: null,
    [EXPLICIT_LOGOUT_KEY]: '1',
  });
}

export function hasExplicitLogout(): boolean {
  if (memoryExplicitLogout) return true;
  try {
    if (localStorage.getItem(EXPLICIT_LOGOUT_KEY) === '1') return true;
  } catch {
    // ignore
  }
  try {
    if (sessionStorage.getItem(EXPLICIT_LOGOUT_KEY) === '1') return true;
  } catch {
    // ignore
  }
  return readWindowNameState()[EXPLICIT_LOGOUT_KEY] === '1';
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };

  let finalUrl = path;
  if (token) {
    headers['X-Session-Token'] = token;
    headers['Authorization'] = `Bearer ${token}`;
    const sep = finalUrl.includes('?') ? '&' : '?';
    finalUrl = `${finalUrl}${sep}_st=${encodeURIComponent(token)}`;
  }

  const res = await fetch(finalUrl, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (!res.ok) {
    let errMsg = `Ошибка запроса (${res.status})`;
    try {
      const data = await res.json();
      if (data && data.error) errMsg = data.error;
    } catch {
      // ignore
    }
    const err = new Error(errMsg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  return res.json() as Promise<T>;
}
