import axios from 'axios';

const LARAVEL_BASE_URL = process.env.LARAVEL_BASE_URL ?? 'http://localhost:8000';

function client(token: string) {
  return axios.create({
    baseURL: LARAVEL_BASE_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });
}

export interface LaravelUser {
  idUtente: number;
  username: string;
  email: string;
  tipoUtente: number;
}

export interface ChatMessage {
  id: number;
  conversation_id: number;
  role: 'user' | 'assistant';
  content: string;
  tool_calls: unknown[] | null;
  created_at: string;
}

export interface Conversation {
  id: number;
  user_id: number;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface StorePayload {
  conversation_id: number | null;
  user_message: string;
  ai_response: string;
  tool_logs?: unknown[] | null;
}

export interface StoreResponse {
  status: string;
  data: {
    conversation: Conversation;
    user_message: ChatMessage;
    ai_response: ChatMessage;
  };
}

export async function validateToken(token: string): Promise<LaravelUser> {
  const response = await client(token).get<LaravelUser>('/api/user');
  return response.data;
}

export async function getChatContext(
  token: string,
  chatId: number
): Promise<ChatMessage[]> {
  const response = await client(token).get<{ status: string; data: ChatMessage[] }>(
    `/api/mcp/chats/${chatId}/context`
  );
  return response.data.data;
}

export async function persistChatExchange(
  token: string,
  payload: StorePayload
): Promise<StoreResponse> {
  const response = await client(token).post<StoreResponse>(
    '/api/mcp/chats/store',
    payload
  );
  return response.data;
}
