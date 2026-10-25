/**
 * Session following rules.
 *
 * The status bar should show the conversation that is actually on screen, not
 * whichever transcript wrote last. VS Code hands us the active editor tab, and
 * the Claude Code panel titles each conversation tab with the conversation's
 * generated title — or, when no title has been generated yet, the latest
 * message the user typed. The tab label is matched against both.
 *
 * Ties are broken by, in order: a session inside this window's workspace, a
 * running session, the freshest transcript.
 *
 * Everything here is pure — no `vscode` import, no file system — so the rules
 * can be unit-tested without an extension host.
 */

export interface FollowCandidate {
  sessionId: string;
  cwd: string;
  /** Newest label Claude Code would show for this session. */
  title: string;
  /**
   * Older labels of the same session. A conversation tab keeps the name it was
   * given, so after a few more messages the tab label is no longer the newest
   * user message — matching any recent label keeps following working.
   */
  altTitles?: string[];
  /** Last transcript write, used to break ties. */
  lastUpdatedAt?: number;
  /** A Claude Code process is currently running this session. */
  live?: boolean;
}

/** Tab labels that mean "a brand-new conversation with no messages yet". */
export const EMPTY_CONVERSATION_TITLES = ['claude code', 'claude'];

/**
 * Messages Claude Code injects into the transcript as `user` lines that are
 * not something the user typed, and that never become a tab title.
 */
const NON_USER_TEXT = /^(\[Request interrupted|\[Request cancelled|<system-reminder>|<command-name>|<local-command|<task-notification|This session is being continue|Caveat: The messages below)/i;

/**
 * The label Claude Code displays for a session.
 *
 * Claude Code's title priority is `agentName || customTitle || aiTitle ||
 * firstPrompt`. Whenever a conversation gets a title — a hook-provided
 * `sessionTitle`, a rename, or a CLI-generated title — Claude Code stores it as
 * a `custom-title` line, and for a hook-provided title also an `agent-name`
 * line. The newest of those is the tab title, so a titled conversation's tab
 * never shows a user message. Older builds wrote `ai-title`; a session with no
 * generated title falls back to the latest message the user actually typed. The
 * backward scan in `getSessionLabels` sees the agent-name line first because it
 * is written right after the custom-title line.
 */
export function transcriptLabel(obj: any): { kind: 'ai-title' | 'title' | 'user'; text: string } | null {
  if (!obj || typeof obj !== 'object') return null;

  if (obj.type === 'custom-title') {
    const title = obj.customTitle || obj.title;
    if (typeof title === 'string' && title.trim()) {
      return { kind: 'title', text: title.trim() };
    }
    return null;
  }

  if (obj.type === 'agent-name') {
    const title = obj.agentName || obj.name;
    if (typeof title === 'string' && title.trim()) {
      return { kind: 'title', text: title.trim() };
    }
    return null;
  }

  if (obj.type === 'ai-title') {
    const title = obj.aiTitle || obj.title;
    if (typeof title === 'string' && title.trim()) {
      return { kind: 'ai-title', text: title.trim() };
    }
    return null;
  }

  if (obj.type !== 'user' || obj.isMeta === true) return null;
  if (!obj.message || obj.message.role !== 'user') return null;

  const content = obj.message.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((part: any) => part && part.type === 'text' && !part.tool_use_id && typeof part.text === 'string')
      .map((part: any) => part.text)
      .join(' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || NON_USER_TEXT.test(text)) return null;
  return { kind: 'user', text };
}

/**
 * Cheap pre-`JSON.parse` filter for transcript lines that can carry a label.
 *
 * Matching on the value instead of on `"type":` matters: Claude Code writes
 * compact lines, but a Python hook's JSON keeps a space after the colon
 * (`{"type": "custom-title", ...}`).
 */
export function mayCarryLabel(line: string): boolean {
  return (
    line.indexOf('"type":"user"') >= 0
    || line.indexOf('"type": "user"') >= 0
    || line.indexOf('"custom-title"') >= 0
    || line.indexOf('"agent-name"') >= 0
    || line.indexOf('"ai-title"') >= 0
  );
}

/**
 * Assemble a session's labels in the order a tab label is matched against them.
 *
 * Generated titles come first because they are what the tab shows; the newest
 * one is the current label and the older ones stay matchable for a tab that has
 * not repainted yet. A user message is only a tab label when the session has no
 * generated title at all, so it comes last.
 */
export function orderSessionLabels(
  titles: string[],
  aiTitle: string,
  userTexts: string[],
): string[] {
  const labels: string[] = [];
  for (const raw of [...titles, aiTitle, ...userTexts]) {
    if (!raw) continue;
    const text = raw.length > 200 ? raw.slice(0, 200) : raw;
    if (!labels.includes(text)) labels.push(text);
  }
  return labels;
}

export type TabMatch =
  /** Bind to this session. */
  | { kind: 'match'; session: FollowCandidate }
  /** The tab is a fresh conversation — show the idle state. */
  | { kind: 'empty' }
  /** The label does not identify a session yet (its title may still be written). */
  | { kind: 'none' };

export function normalizeTitle(title: string): string {
  return (title || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Normalise a tab label.
 *
 * VS Code sometimes decorates webview tab labels with a " - Claude Code"
 * suffix; nothing else is stripped, because punctuation is part of the title.
 */
export function cleanTabLabel(label: string): string {
  return (label || '')
    .replace(/\s+[-–—·]\s+Claude Code\s*$/i, '')
    .trim();
}

/** Normalise a path for comparison (Windows paths are case-insensitive). */
export function normalizePathForCompare(p: string): string {
  let s = (p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-zA-Z]:/.test(s) || s.startsWith('//')) s = s.toLowerCase();
  return s;
}

/**
 * How well a session's working directory matches this window.
 *   2 — the session runs inside the workspace (the usual case)
 *   1 — the workspace is inside the session's directory (opened a subfolder)
 *   0 — unrelated
 */
export function workspaceScore(cwd: string, roots: string[]): 0 | 1 | 2 {
  if (!cwd || !roots || roots.length === 0) return 0;
  const c = normalizePathForCompare(cwd);
  if (!c) return 0;
  let best: 0 | 1 | 2 = 0;
  for (const root of roots) {
    const r = normalizePathForCompare(root);
    if (!r) continue;
    if (c === r || c.startsWith(r + '/')) return 2;
    if (r.startsWith(c + '/')) best = 1;
  }
  return best;
}

function rank(a: FollowCandidate, b: FollowCandidate, roots: string[], preferLive: boolean): number {
  const wa = workspaceScore(a.cwd, roots);
  const wb = workspaceScore(b.cwd, roots);
  if (wa !== wb) return wb - wa;
  if (preferLive && !!a.live !== !!b.live) return a.live ? -1 : 1;
  return (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0);
}

function best(list: FollowCandidate[], roots: string[], preferLive: boolean): FollowCandidate {
  let winner = list[0];
  for (let i = 1; i < list.length; i++) {
    if (rank(list[i], winner, roots, preferLive) < 0) winner = list[i];
  }
  return winner;
}

function allTitles(c: FollowCandidate): string[] {
  const out: string[] = [];
  for (const title of [c.title, ...(c.altTitles || [])]) {
    const normalized = normalizeTitle(title);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * Where in this session the label sits, newest first: 0 is the message the tab
 * is most likely named after, higher numbers are older messages.
 */
function labelIndex(c: FollowCandidate, target: string): number {
  const titles = [c.title, ...(c.altTitles || [])];
  for (let i = 0; i < titles.length; i++) {
    if (normalizeTitle(titles[i]) === target) return i;
  }
  return -1;
}

/** Where the newest title that starts with `stem` sits, or -1. */
function prefixIndex(c: FollowCandidate, stem: string): number {
  const titles = [c.title, ...(c.altTitles || [])];
  for (let i = 0; i < titles.length; i++) {
    if (normalizeTitle(titles[i]).startsWith(stem)) return i;
  }
  return -1;
}

/**
 * The candidates whose label sits closest to their newest message, and -1 when
 * none match. Ties are deliberately left in the same group: identical labels
 * at the same position are genuinely ambiguous.
 */
function closest(candidates: FollowCandidate[], indexOf: (c: FollowCandidate) => number): FollowCandidate[] {
  let bestIndex = Number.POSITIVE_INFINITY;
  const group: FollowCandidate[] = [];
  for (const c of candidates) {
    const index = indexOf(c);
    if (index < 0) continue;
    if (index < bestIndex) {
      bestIndex = index;
      group.length = 0;
    }
    if (index === bestIndex) group.push(c);
  }
  return group;
}

/**
 * Match the active conversation tab to a session.
 *
 * Exact titles win, including the session's recent labels. When several
 * sessions used the same words ("继续" is a very common message), the session
 * where the label is the most recent message wins: a tab keeps the name it was
 * given, so the closer the label is to that session's newest message, the more
 * likely it is the tab the user is looking at. Ties inside that group fall back
 * to workspace, running state and freshness.
 *
 * A truncated label ("Fix the auth…") resolves to a running session whose
 * title starts with it, and only falls back to "exactly one such title" when
 * no session is running. A fresh-conversation label binds to the only untitled
 * live session when there is exactly one, and otherwise means idle.
 */
export function pickSessionForTab(
  label: string,
  candidates: FollowCandidate[],
  workspaceRoots: string[] = [],
): TabMatch {
  const raw = cleanTabLabel(label);
  if (!raw) return { kind: 'none' };
  const target = normalizeTitle(raw);

  const exact = closest(candidates, c => labelIndex(c, target));
  if (exact.length > 0) {
    return { kind: 'match', session: best(exact, workspaceRoots, true) };
  }

  // VS Code truncates long tab labels with "…" (or "..."). Several sessions can
  // start with the same words (people paste the same path into more than one
  // conversation), so the most recent use of the prefix wins, exactly like an
  // exact label.
  //
  // Position stays the primary signal on purpose: opening a conversation tab
  // starts its Claude Code process, so at the instant of the switch the session
  // on screen may have no session file yet and look "not running". Only a tie —
  // two sessions claiming the prefix at the same position — falls back to
  // whether the session is running, which is the one thing the ellipsis cannot
  // hide: Claude Code cuts the tab title at 24 characters, and
  // `"C:\Users\Administrator\…` fits both `…\Desktop\MC` and `…\Desktop\SSH
  // 实验.pdf`. Without that tie-break the label looks ambiguous, nothing is
  // picked, and the status bar stays pinned to whatever was shown before.
  const stem = target.replace(/(?:…|\.\.\.)$/u, '').trim();
  if (stem && stem !== target) {
    const prefixed = closest(candidates, c => prefixIndex(c, stem));
    if (prefixed.length === 1) {
      return { kind: 'match', session: prefixed[0] };
    }
    const running = prefixed.filter(c => c.live);
    if (running.length === 1) {
      return { kind: 'match', session: running[0] };
    }
    // Nothing is running — the switch happened before Claude Code finished
    // starting the session on screen — or several sessions are. Freshness in
    // this window is the only signal left, and guessing beats staying pinned to
    // the previous session: a wrong guess self-corrects on the next poll, a
    // stuck status bar shows another conversation's numbers indefinitely.
    const pool = running.length > 0 ? running : prefixed;
    if (pool.length > 0) {
      return { kind: 'match', session: best(pool, workspaceRoots, true) };
    }
  }

  if (EMPTY_CONVERSATION_TITLES.includes(target)) {
    const untitled = candidates.filter(c => allTitles(c).length === 0 && c.live);
    if (untitled.length === 1) {
      return { kind: 'match', session: untitled[0] };
    }
    return { kind: 'empty' };
  }

  return { kind: 'none' };
}

/**
 * Default follow target when no conversation tab identifies a session: the
 * freshest session in this window's workspace, falling back to the freshest
 * session anywhere.
 */
export function pickNewestSession(
  candidates: FollowCandidate[],
  workspaceRoots: string[] = [],
): FollowCandidate | null {
  if (!candidates || candidates.length === 0) return null;
  const inWorkspace = candidates.filter(c => workspaceScore(c.cwd, workspaceRoots) > 0);
  return best(inWorkspace.length > 0 ? inWorkspace : candidates, workspaceRoots, false);
}