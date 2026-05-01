import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { Response } from 'express';
import { getDiscoveredTools, callTool } from './mcp.client';

type LLMProvider = 'openai' | 'anthropic';

const PROVIDER = (process.env.LLM_PROVIDER ?? 'anthropic') as LLMProvider;
const MODEL = process.env.LLM_MODEL ?? 'claude-opus-4-7';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMResult {
  finalText: string;
  toolLogs: unknown[];
}

function sseWrite(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function streamChat(
  res: Response,
  messages: ConversationMessage[],
  systemPrompt?: string
): Promise<LLMResult> {
  if (PROVIDER === 'openai') {
    return streamOpenAI(res, messages, systemPrompt);
  }
  return streamAnthropic(res, messages, systemPrompt);
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

async function streamOpenAI(
  res: Response,
  messages: ConversationMessage[],
  systemPrompt?: string
): Promise<LLMResult> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const mcpTools = getDiscoveredTools();
  const toolLogs: unknown[] = [];

  const openAIMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  if (systemPrompt) {
    openAIMessages.push({ role: 'system', content: systemPrompt });
  }
  for (const m of messages) {
    openAIMessages.push({ role: m.role, content: m.content });
  }

  const tools: OpenAI.Chat.ChatCompletionTool[] = mcpTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    },
  }));

  let finalText = '';

  while (true) {
    const stream = await openai.chat.completions.create({
      model: MODEL,
      messages: openAIMessages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      stream: true,
    });

    let currentText = '';
    const pendingToolCalls = new Map<number, { id: string; name: string; argsRaw: string }>();
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        currentText += delta.content;
        sseWrite(res, 'delta', { text: delta.content });
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!pendingToolCalls.has(tc.index)) {
            pendingToolCalls.set(tc.index, { id: '', name: '', argsRaw: '' });
          }
          const entry = pendingToolCalls.get(tc.index)!;
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.argsRaw += tc.function.arguments;
        }
      }

      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }
    }

    finalText += currentText;

    if (finishReason !== 'tool_calls' || pendingToolCalls.size === 0) {
      break;
    }

    const toolCallsForHistory: OpenAI.Chat.ChatCompletionMessageToolCall[] =
      Array.from(pendingToolCalls.values()).map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.argsRaw },
      }));

    openAIMessages.push({
      role: 'assistant',
      content: currentText || null,
      tool_calls: toolCallsForHistory,
    });

    for (const tc of Array.from(pendingToolCalls.values())) {
      const args = JSON.parse(tc.argsRaw) as Record<string, unknown>;

      sseWrite(res, 'tool_start', { name: tc.name, args });

      let toolResult: unknown;
      try {
        toolResult = await callTool(tc.name, args);
      } catch (err) {
        toolResult = { error: String(err) };
      }

      toolLogs.push({ tool: tc.name, args, result: toolResult });
      sseWrite(res, 'tool_end', { name: tc.name, result: toolResult });

      openAIMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  return { finalText, toolLogs };
}

// ─── Anthropic ───────────────────────────────────────────────────────────────

async function streamAnthropic(
  res: Response,
  messages: ConversationMessage[],
  systemPrompt?: string
): Promise<LLMResult> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const mcpTools = getDiscoveredTools();
  const toolLogs: unknown[] = [];

  const tools: Anthropic.Tool[] = mcpTools.map(tool => ({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: (tool.inputSchema as Anthropic.Tool['input_schema']) ?? {
      type: 'object' as const,
      properties: {},
    },
  }));

  const anthropicMessages: Anthropic.MessageParam[] = messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  let finalText = '';

  while (true) {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: anthropicMessages,
      tools: tools.length > 0 ? tools : undefined,
    });

    let currentText = '';
    let stopReason: string | null = null;
    const pendingToolUses: Array<{ id: string; name: string; inputRaw: string }> = [];
    let currentToolUse: { id: string; name: string; inputRaw: string } | null = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          currentToolUse = {
            id: event.content_block.id,
            name: event.content_block.name,
            inputRaw: '',
          };
        }
      }

      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          currentText += event.delta.text;
          sseWrite(res, 'delta', { text: event.delta.text });
        }
        if (event.delta.type === 'input_json_delta' && currentToolUse) {
          currentToolUse.inputRaw += event.delta.partial_json;
        }
      }

      if (event.type === 'content_block_stop' && currentToolUse) {
        pendingToolUses.push(currentToolUse);
        currentToolUse = null;
      }

      if (event.type === 'message_delta') {
        stopReason = event.delta.stop_reason ?? null;
      }
    }

    finalText += currentText;

    if (stopReason !== 'tool_use' || pendingToolUses.length === 0) {
      break;
    }

    console.log(`[LLM] Anthropic requesting ${pendingToolUses.length} tool call(s)`);

    const assistantContent: Anthropic.ContentBlock[] = [];
    if (currentText) {
      assistantContent.push({ type: 'text', text: currentText });
    }
    for (const tu of pendingToolUses) {
      assistantContent.push({
        type: 'tool_use',
        id: tu.id,
        name: tu.name,
        input: JSON.parse(tu.inputRaw || '{}') as Record<string, unknown>,
      });
    }

    anthropicMessages.push({ role: 'assistant', content: assistantContent });

    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];

    for (const tu of pendingToolUses) {
      const args = JSON.parse(tu.inputRaw || '{}') as Record<string, unknown>;

      sseWrite(res, 'tool_start', { name: tu.name, args });

      let toolResult: unknown;
      try {
        toolResult = await callTool(tu.name, args);
      } catch (err) {
        toolResult = { error: String(err) };
      }

      toolLogs.push({ tool: tu.name, args, result: toolResult });
      sseWrite(res, 'tool_end', { name: tu.name, result: toolResult });

      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(toolResult),
      });
    }

    anthropicMessages.push({ role: 'user', content: toolResultBlocks });
  }

  return { finalText, toolLogs };
}
