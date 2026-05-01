import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initMcpClient } from './services/mcp.client';
import { chatRouter } from './routes/chat';

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors());
app.use(express.json());

// app.use('/v1', chatRouter);
app.use(chatRouter);

async function bootstrap() {
  try {
    await initMcpClient();
    console.log('[MCP] Tools discovered and client ready.');
  } catch (err) {
    console.warn('[MCP] MCP client unavailable — tool calls disabled.', err);
  }

  app.listen(PORT, () => {
    console.log(`[Orchestrator] Listening on port ${PORT}`);
  });
}

bootstrap();
