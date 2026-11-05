import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Modality } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '20mb' }));

// Health check endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    hasApiKey: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY')
  });
});

// Server-side Gemini TTS Proxy Route
app.post('/api/tts', async (req: Request, res: Response) => {
  try {
    const { prompt, voiceName, clientApiKey } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Texto para geração de voz é obrigatório.' });
    }

    // Support MOCK mode for instant preview / stress testing without rate limits
    if (typeof clientApiKey === 'string' && clientApiKey.trim().toUpperCase() === 'MOCK') {
      return res.json({ isMock: true });
    }

    // Determine API Key: Client override (if provided) or server environment key
    const effectiveApiKey = (clientApiKey && clientApiKey.trim() !== 'MY_GEMINI_API_KEY' && clientApiKey.trim().length > 15)
      ? clientApiKey.trim()
      : process.env.GEMINI_API_KEY;

    if (!effectiveApiKey || effectiveApiKey === 'MY_GEMINI_API_KEY') {
      return res.status(401).json({
        error: 'Chave de API do Gemini não configurada no servidor. Configure GEMINI_API_KEY nas variáveis de ambiente.'
      });
    }

    const ai = new GoogleGenAI({ apiKey: effectiveApiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-tts-preview',
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voiceName || 'Achird'
            }
          }
        }
      }
    });

    const pcmData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    const mimeType = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.mimeType || 'audio/L16;rate=24000';

    if (!pcmData) {
      return res.status(502).json({ error: 'Nenhum dado de áudio foi retornado pela API Gemini.' });
    }

    return res.json({ pcmData, mimeType });
  } catch (err: any) {
    const errorMsg = err?.message || 'Erro inesperado na geração de áudio.';
    const status = err?.status === 429 || errorMsg.includes('429') || errorMsg.includes('quota')
      ? 429
      : errorMsg.includes('API key') || errorMsg.includes('401')
      ? 401
      : 500;

    return res.status(status).json({
      error: errorMsg,
      status
    });
  }
});

// Dev vs Prod Vite Integration
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: { middlewareMode: true, host: '0.0.0.0', port: PORT },
    appType: 'spa'
  });
  app.use(vite.middlewares);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[VozBR Server] Listening on http://0.0.0.0:${PORT}`);
});
