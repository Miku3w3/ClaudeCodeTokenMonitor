/**
 * TranscriptParser — parses individual JSONL lines from Claude Code transcript files.
 *
 * Each line is a JSON object representing an event: user message, assistant response,
 * AI-generated title, tool result, system attachment, etc.
 */
import type { ParsedEvent, TokenUsage } from '../model/types';

/**
 * Parse a single JSONL line into a typed ParsedEvent.
 * Returns null for events we don't care about (system attachments, mode changes, etc.).
 */
export function parseLine(lineJson: string): ParsedEvent | null {
  // Trim and skip empty lines
  const trimmed = lineJson.trim();
  if (!trimmed) {
    return null;
  }

  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // Corrupt line — skip
    return null;
  }

  const type = obj.type as string | undefined;
  if (!type) {
    return null;
  }

  // --- Assistant message (contains token usage) ---
  if (type === 'assistant') {
    const message = obj.message;
    if (!message || message.role !== 'assistant') {
      return null;
    }

    const usage: TokenUsage | undefined = message.usage;
    if (!usage) {
      return null; // No usage data == not useful
    }

    // Every streaming snapshot of this response shares message.id, but each
    // line gets a fresh uuid. Callers MUST dedupe by messageId (keeping the
    // snapshot with the largest output_tokens), not by uuid.
    return {
      type: 'assistant',
      timestamp: obj.timestamp || new Date().toISOString(),
      uuid: obj.uuid || message.id || '',
      sessionId: obj.sessionId || '',
      isRealUserMessage: false,
      messageId: message.id || obj.uuid || '',
      cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
      slug: typeof obj.slug === 'string' ? obj.slug : undefined,
      agentId: typeof obj.agentId === 'string' ? obj.agentId : undefined,
      isSidechain: obj.isSidechain === true ? true : undefined,
      usage,
      model: message.model || 'unknown',
    };
  }

  // --- User message (real user input, not tool result) ---
  if (type === 'user') {
    const message = obj.message;
    if (!message || message.role !== 'user') {
      return null;
    }

    // Determine if this is a real user message or a tool_result
    const content = message.content;
    let isRealUserMessage = false;

    if (Array.isArray(content)) {
      // Check if any content item is a text message without tool_use_id
      // Tool results have tool_use_id fields; real user messages don't
      isRealUserMessage = content.some(
        (item: any) =>
          item.type === 'text' &&
          !item.tool_use_id &&
          typeof item.text === 'string'
      );
    } else if (typeof content === 'string') {
      isRealUserMessage = true;
    }

    if (!isRealUserMessage) {
      // Return tool_result events — needed for turn-based AI time accumulation
      return {
        type: 'tool_result',
        timestamp: obj.timestamp || new Date().toISOString(),
        uuid: obj.uuid || '',
        sessionId: obj.sessionId || '',
        isRealUserMessage: false,
        cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
        slug: typeof obj.slug === 'string' ? obj.slug : undefined,
        agentId: typeof obj.agentId === 'string' ? obj.agentId : undefined,
        isSidechain: obj.isSidechain === true ? true : undefined,
      };
    }

    return {
      type: 'user',
      timestamp: obj.timestamp || new Date().toISOString(),
      uuid: obj.uuid || '',
      sessionId: obj.sessionId || '',
      isRealUserMessage: true,
      cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
      slug: typeof obj.slug === 'string' ? obj.slug : undefined,
      agentId: typeof obj.agentId === 'string' ? obj.agentId : undefined,
      isSidechain: obj.isSidechain === true ? true : undefined,
    };
  }

  // --- Conversation title written by a UserPromptSubmit hook ---
  // Claude Code stores a hook-provided `sessionTitle` as a `custom-title` line
  // followed by an `agent-name` line. Both are title events: the status bar
  // shows the conversation's title, and the title changes at checkpoints in the
  // middle of a session, not only when the session changes.
  if (type === 'custom-title' || type === 'agent-name') {
    return {
      type: 'ai-title',
      timestamp: obj.timestamp || new Date().toISOString(),
      uuid: '',
      sessionId: obj.sessionId || '',
      isRealUserMessage: false,
      title: obj.customTitle || obj.agentName || '',
    };
  }

  // --- AI-generated conversation title ---
  if (type === 'ai-title') {
    return {
      type: 'ai-title',
      timestamp: obj.timestamp || new Date().toISOString(),
      uuid: '',
      sessionId: obj.sessionId || '',
      isRealUserMessage: false,
      title: obj.aiTitle || obj.title || '',
    };
  }

  // --- Queue operation (session lifecycle) ---
  if (type === 'queue-operation') {
    return {
      type: 'other',
      timestamp: obj.timestamp || new Date().toISOString(),
      uuid: '',
      sessionId: obj.sessionId || '',
      isRealUserMessage: false,
    };
  }

  // All other types: attachment, system, file-history-snapshot, etc.
  return null;
}
