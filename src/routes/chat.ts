import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getChatContext, persistChatExchange } from '../services/laravel.bridge';
import { streamChat, ConversationMessage } from '../services/llm.provider';

export const chatRouter = Router();

chatRouter.post('/chat', authMiddleware, async (req: Request, res: Response) => {
  const { chat_id, message, system_prompt } = req.body as {
    chat_id?: number;
    message: string;
    system_prompt?: string;
  };

  const token = res.locals.token as string;

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: '`message` is required.' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let history: ConversationMessage[] = [];

  if (chat_id) {
    try {
      const contextMessages = await getChatContext(token, chat_id);
      history = contextMessages.map(m => ({ role: m.role, content: m.content }));
    } catch (err) {
      console.warn('[Chat] Could not load context, proceeding without history:', err);
    }
  }

  history.push({ role: 'user', content: message });

  let result: { finalText: string; toolLogs: unknown[] };

  try {
    result = await streamChat(res, history, system_prompt);
  } catch (err) {
    console.error('[Chat] LLM error:', err);
    res.write(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`);
    res.end();
    return;
  }

  let conversationId: number | null = null;

  try {
    const stored = await persistChatExchange(token, {
      conversation_id: chat_id ?? null,
      user_message: message,
      ai_response: result.finalText,
      tool_logs: result.toolLogs.length > 0 ? result.toolLogs : null,
    });
    conversationId = stored.data.conversation.id;
  } catch (err) {
    console.error('[Chat] Failed to persist exchange to Laravel:', err);
  }

  res.write(
    `event: done\ndata: ${JSON.stringify({
      conversation_id: conversationId,
      full_text: result.finalText,
    })}\n\n`
  );

  res.end();
});
