import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  pickSessionForTab,
  pickNewestSession,
  workspaceScore,
  normalizeTitle,
  cleanTabLabel,
  transcriptLabel,
} = require('../out/core/sessionFollow.js');

const WS = ['D:\\Jobs\\claude-code\\vscode-claude-token-monitor'];

function candidate(overrides = {}) {
  return {
    sessionId: 's1',
    cwd: 'D:\\Jobs\\claude-code\\vscode-claude-token-monitor',
    title: 'Fix the auth bug',
    lastUpdatedAt: 1000,
    live: false,
    ...overrides,
  };
}

test('normalizes titles for comparison', () => {
  assert.equal(normalizeTitle('  Fix   THE auth bug \n'), 'fix the auth bug');
  assert.equal(normalizeTitle(undefined), '');
});

test('strips the Claude Code suffix from a tab label', () => {
  assert.equal(cleanTabLabel('Fix the auth bug - Claude Code'), 'Fix the auth bug');
  assert.equal(cleanTabLabel('Fix the auth bug'), 'Fix the auth bug');
  assert.equal(cleanTabLabel('  '), '');
});

test('matches an exact title case- and whitespace-insensitively', () => {
  const result = pickSessionForTab('fix  the AUTH bug', [candidate()], WS);
  assert.equal(result.kind, 'match');
  assert.equal(result.session.sessionId, 's1');
});

test('prefers the session from this workspace over another window with the same title', () => {
  const other = candidate({ sessionId: 'other', cwd: 'D:\\Jobs\\claude-code\\unrelated' });
  const mine = candidate({ sessionId: 'mine', cwd: 'D:\\Jobs\\claude-code\\vscode-claude-token-monitor\\src' });
  const result = pickSessionForTab('Fix the auth bug', [other, mine], WS);
  assert.equal(result.kind, 'match');
  assert.equal(result.session.sessionId, 'mine');
});

test('prefers a running session when both match equally', () => {
  const cold = candidate({ sessionId: 'cold', live: false, lastUpdatedAt: 9999 });
  const live = candidate({ sessionId: 'live', live: true, lastUpdatedAt: 1 });
  const result = pickSessionForTab('Fix the auth bug', [cold, live], WS);
  assert.equal(result.kind, 'match');
  assert.equal(result.session.sessionId, 'live');
});

test('breaks a remaining tie by the freshest transcript', () => {
  const older = candidate({ sessionId: 'older', lastUpdatedAt: 10 });
  const newer = candidate({ sessionId: 'newer', lastUpdatedAt: 20 });
  const result = pickSessionForTab('Fix the auth bug', [older, newer], WS);
  assert.equal(result.session.sessionId, 'newer');
});

test('matches an older label of the same session', () => {
  const session = candidate({
    sessionId: 's1',
    title: 'latest message',
    altTitles: ['继续', '不需要了，停掉吧'],
  });
  const result = pickSessionForTab('继续', [session], WS);
  assert.equal(result.kind, 'match');
  assert.equal(result.session.sessionId, 's1');
});

test('matches a label that is far behind the newest message', () => {
  // A tab keeps the name it was given; after dozens of newer messages its
  // label only exists deep in the transcript, which the deep scan reaches.
  const session = candidate({
    sessionId: 'old-tab',
    title: 'newest message',
    altTitles: Array.from({ length: 40 }, (_, i) => `older message ${i}`).concat('sticky tab label'),
  });
  const result = pickSessionForTab('sticky tab label', [session], WS);
  assert.equal(result.kind, 'match');
  assert.equal(result.session.sessionId, 'old-tab');
});

test('never matches an unrelated label', () => {
  const result = pickSessionForTab('extension.ts', [candidate()], WS);
  assert.equal(result.kind, 'none');
});

test('the session where the label is newest wins, even if another transcript is fresher', () => {
  // Real case: the "继续" tab belonged to the session where 继续 was a recent
  // message, but another tab had also said 继续 further back and kept writing,
  // so its mtime won the old tie-break and stuck forever.
  const onScreen = candidate({
    sessionId: 'on-screen',
    title: '整体恢复了，但是应该还有些小bug',
    altTitles: ['继续'],
    lastUpdatedAt: 1,
  });
  const background = candidate({
    sessionId: 'background',
    title: '如果中夹英怎么办？',
    altTitles: ['改一下这个', '不对，再试一次', '继续'],
    lastUpdatedAt: 9_999_999,
  });
  const result = pickSessionForTab('继续', [background, onScreen], WS);
  assert.equal(result.kind, 'match');
  assert.equal(result.session.sessionId, 'on-screen');
});

test('an exact newest title beats an older mention of the same words', () => {
  const primary = candidate({ sessionId: 'primary', title: '如果中夹英怎么办？', lastUpdatedAt: 1 });
  const older = candidate({
    sessionId: 'older',
    title: 'something else',
    altTitles: ['如果中夹英怎么办？'],
    lastUpdatedAt: 9_999_999,
  });
  const result = pickSessionForTab('如果中夹英怎么办？', [older, primary], WS);
  assert.equal(result.kind, 'match');
  assert.equal(result.session.sessionId, 'primary');
});

test('matches a tab label VS Code truncated with an ellipsis', () => {
  const long = candidate({
    sessionId: 'long',
    title: 'Investigate the intermittent audio dropout in games',
  });
  const result = pickSessionForTab('Investigate the intermittent audio…', [long], WS);
  assert.equal(result.kind, 'match');
  assert.equal(result.session.sessionId, 'long');
});

test('does not guess when a truncated label matches nothing', () => {
  const a = candidate({ sessionId: 'a', title: 'Pricing update part one' });
  const b = candidate({ sessionId: 'b', title: 'Deploy notes for production' });
  const result = pickSessionForTab('Pricing update…', [a, b], WS);
  assert.equal(result.kind, 'match');
  assert.equal(result.session.sessionId, 'a');

  const miss = pickSessionForTab('Something entirely different…', [a, b], WS);
  assert.equal(miss.kind, 'none');
});

test('a truncated label ignores a stale session that only starts with the same words', () => {
  // Real case: Claude Code cuts the tab title at 24 characters, so a pasted
  // path stops right where two conversations stop looking alike —
  // `"C:\Users\Administrator\…` fits both. Only one of them is running; the
  // other is a months-old index entry and must not make the label ambiguous.
  const stale = candidate({
    sessionId: 'stale',
    title: '"C:\\Users\\Administrator\\Desktop\\MC"帮我看看有没有问题',
  });
  const mine = candidate({
    sessionId: 'mine',
    title: '"C:\\Users\\Administrator\\Desktop\\SSH实验.pdf" 我现在有一门实验',
    live: true,
    lastUpdatedAt: 500,
  });
  const result = pickSessionForTab('"C:\\Users\\Administrator\\…', [stale, mine], WS);
  assert.equal(result.kind, 'match');
  assert.equal(result.session.sessionId, 'mine');
});

test('a truncated label resolves to the session that used those words most recently', () => {
  // Real case: a path was pasted into two conversations, so both transcripts
  // start with the same words. The tab belongs to the session where that
  // message is the newest one, not the one where it is an older message.
  const mine = candidate({
    sessionId: 'mine',
    title: '"D:\\Jobs\\html\\ASP.NET Core Web\\MyBookStore" check this',
  });
  const other = candidate({
    sessionId: 'other',
    title: '如果中夹英怎么办？',
    altTitles: ['那这个skill是自动识别视频有没有声音', '"D:\\Jobs\\html\\ASP.NET Core Web\\Test"'],
  });
  const result = pickSessionForTab('"D:\\Jobs\\html\\ASP.NET Co…', [other, mine], WS);
  assert.equal(result.kind, 'match');
  assert.equal(result.session.sessionId, 'mine');
});

test('position beats running state — a tab opens its process lazily', () => {
  // Real case: switching to a conversation tab starts its Claude Code process,
  // so at the instant of the switch the session on screen has no session file
  // and looks dead, while an old conversation that happens to contain the same
  // path eighty messages back looks alive. Position decides; only a tie at the
  // same position falls back to running state.
  const mine = candidate({
    sessionId: 'mine',
    title: '"C:\\Users\\Administrator\\Desktop\\SSH实验.pdf" 我现在有一门实验',
    live: false,
  });
  const other = candidate({
    sessionId: 'other',
    title: '首次从这个对话切换过去',
    altTitles: [
      '后来切多几次都可以',
      '还有没有别的问题？',
      '"C:\\Users\\Administrator\\Desktop\\屏幕截图.png" 帮我看一下',
    ],
    live: true,
    lastUpdatedAt: 9999,
  });
  const result = pickSessionForTab('"C:\\Users\\Administrator\\…', [other, mine], WS);
  assert.equal(result.kind, 'match');
  assert.equal(result.session.sessionId, 'mine');
});

test('two running sessions sharing a truncated label fall back to the freshest', () => {
  const older = candidate({ sessionId: 'older', title: 'Deploy notes for staging', live: true, lastUpdatedAt: 100 });
  const newer = candidate({ sessionId: 'newer', title: 'Deploy notes for production', live: true, lastUpdatedAt: 900 });
  const result = pickSessionForTab('Deploy notes fo…', [older, newer], WS);
  assert.equal(result.kind, 'match');
  assert.equal(result.session.sessionId, 'newer');
});

test('stale sessions sharing a truncated label fall back to the freshest in this window', () => {
  // Neither session has a process yet — the tab was opened a heartbeat ago and
  // Claude Code is still starting it. Freshness is the only signal left, and a
  // guess that self-corrects beats a status bar stuck on the previous session.
  const older = candidate({ sessionId: 'older', title: 'Pricing update part one', live: false, lastUpdatedAt: 100 });
  const newer = candidate({ sessionId: 'newer', title: 'Pricing update part two', live: false, lastUpdatedAt: 900 });
  const result = pickSessionForTab('Pricing update…', [older, newer], WS);
  assert.equal(result.kind, 'match');
  assert.equal(result.session.sessionId, 'newer');
});

test('a truncated label resolves to the session that used those words most recently', () => {
  // Real case: a path was pasted into two conversations, so both transcripts
  // start with the same words. The tab belongs to the session where that
  // message is the newest one, not the one where it is an older message.
  const mine = candidate({
    sessionId: 'mine',
    title: '"D:\\Jobs\\html\\ASP.NET Core Web\\MyBookStore" check this',
  });
  const other = candidate({
    sessionId: 'other',
    title: '如果中夹英怎么办？',
    altTitles: ['那这个skill是自动识别视频有没有声音', '"D:\\Jobs\\html\\ASP.NET Core Web\\Test"'],
  });
  const result = pickSessionForTab('"D:\\Jobs\\html\\ASP.NET Co…', [other, mine], WS);
  assert.equal(result.kind, 'match');
  assert.equal(result.session.sessionId, 'mine');
});

test('an exact title wins over a truncated prefix', () => {
  const exact = candidate({ sessionId: 'exact', title: 'Fix…' });
  const prefix = candidate({ sessionId: 'prefix', title: 'Fix the auth bug' });
  const result = pickSessionForTab('Fix…', [prefix, exact], WS);
  assert.equal(result.session.sessionId, 'exact');
});

test('a brand-new conversation binds to the only untitled live session', () => {
  const untitled = candidate({ sessionId: 'fresh', title: '', live: true });
  const titled = candidate({ sessionId: 'old', title: 'Fix the auth bug', live: true });
  const result = pickSessionForTab('Claude Code', [titled, untitled], WS);
  assert.equal(result.kind, 'match');
  assert.equal(result.session.sessionId, 'fresh');
});

test('a brand-new conversation with no untitled session means idle', () => {
  const result = pickSessionForTab('Claude Code', [candidate()], WS);
  assert.equal(result.kind, 'empty');
});

test('an untitled session only counts while it is running', () => {
  const stale = candidate({ sessionId: 'stale', title: '', live: false });
  const result = pickSessionForTab('Claude Code', [stale], WS);
  assert.equal(result.kind, 'empty');
});

test('an empty label matches nothing', () => {
  assert.equal(pickSessionForTab('', [candidate()], WS).kind, 'none');
  assert.equal(pickSessionForTab('   ', [candidate()], WS).kind, 'none');
});

test('workspace scoring understands nesting in both directions', () => {
  assert.equal(workspaceScore('D:\\Jobs\\claude-code\\vscode-claude-token-monitor', WS), 2);
  assert.equal(workspaceScore('D:\\Jobs\\claude-code\\vscode-claude-token-monitor\\src', WS), 2);
  // Windows paths compare case-insensitively.
  assert.equal(workspaceScore('d:/jobs/claude-code/vscode-claude-token-monitor/src', WS), 2);
  // The workspace is inside the session's directory.
  assert.equal(workspaceScore('D:\\Jobs\\claude-code', WS), 1);
  assert.equal(workspaceScore('D:\\Jobs\\unrelated', WS), 0);
  assert.equal(workspaceScore('', WS), 0);
  assert.equal(workspaceScore('D:\\Jobs', []), 0);
});

test('the fallback picks the freshest session in this workspace, not another project', () => {
  const otherProject = candidate({
    sessionId: 'other-project',
    cwd: 'D:\\Jobs\\claude-code\\other',
    lastUpdatedAt: 9_999_999,
  });
  const mine = candidate({ sessionId: 'mine', lastUpdatedAt: 1000 });
  const result = pickNewestSession([otherProject, mine], WS);
  assert.equal(result.sessionId, 'mine');
});

test('the fallback falls back to the freshest session anywhere when the workspace has none', () => {
  const a = candidate({ sessionId: 'a', cwd: 'D:\\Jobs\\x', lastUpdatedAt: 10 });
  const b = candidate({ sessionId: 'b', cwd: 'D:\\Jobs\\y', lastUpdatedAt: 20 });
  const result = pickNewestSession([a, b], ['D:\\Jobs\\not-here']);
  assert.equal(result.sessionId, 'b');
});

test('the fallback returns null when there is nothing to follow', () => {
  assert.equal(pickNewestSession([], WS), null);
  assert.equal(pickNewestSession(null, WS), null);
});

test('reads an ai-title line', () => {
  assert.deepEqual(
    transcriptLabel({ type: 'ai-title', aiTitle: 'Fix the auth bug' }),
    { kind: 'ai-title', text: 'Fix the auth bug' },
  );
});

test('reads a plain user message and collapses whitespace', () => {
  assert.deepEqual(
    transcriptLabel({ type: 'user', message: { role: 'user', content: '  继续\n\n 吧  ' } }),
    { kind: 'user', text: '继续 吧' },
  );
});

test('reads text blocks but ignores tool results', () => {
  assert.deepEqual(
    transcriptLabel({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'x', content: 'big output' },
          { type: 'text', text: '继续' },
        ],
      },
    }),
    { kind: 'user', text: '继续' },
  );
  assert.equal(
    transcriptLabel({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'out' }] },
    }),
    null,
  );
});

test('ignores injected user lines that never become a tab title', () => {
  for (const content of [
    '[Request interrupted by user for tool use]',
    '<system-reminder>something</system-reminder>',
    '<command-name>/compact</command-name>',
    '<task-notification> <task-id>b1</task-id></task-notification>',
    'This session is being continued from a previous conversation...',
    'Caveat: The messages below were generated by the user',
  ]) {
    assert.equal(
      transcriptLabel({ type: 'user', message: { role: 'user', content } }),
      null,
      content,
    );
  }
});

test('ignores meta messages and non-user events', () => {
  assert.equal(transcriptLabel({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } }), null);
  assert.equal(transcriptLabel({ type: 'assistant', message: { role: 'assistant', content: 'hi' } }), null);
  assert.equal(transcriptLabel({ type: 'user', message: { role: 'assistant', content: 'hi' } }), null);
  assert.equal(transcriptLabel(null), null);
});