# Eklavya Backend

AI-powered educational content ingestion and RAG system with PDF/Video pipelines.

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required:
- **Supabase** (for authentication): Get free credentials from [supabase.com](https://supabase.com)
- **OpenRouter** (for AI features): Get a FREE API key from [openrouter.ai/keys](https://openrouter.ai/keys)

### 3. Run Development Server
```bash
npm run dev
```

Server starts at `http://localhost:3000`

### 4. Test Health Check
```bash
curl http://localhost:3000/health
```

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check |
| `/api/auth/signup` | POST | Create account |
| `/api/auth/login` | POST | Login |
| `/api/ingest/pdf` | POST | Upload PDF |
| `/api/ingest/video` | POST | Upload video/audio |
| `/api/ask` | POST | RAG Q&A |
| `/api/cards` | GET | Get AI content cards |
| `/api/reels` | GET | Get generated reels |

## Deployment (Railway)

1. Push to GitHub
2. Connect repo to Railway
3. Set environment variables in Railway dashboard
4. Deploy

## Tech Stack

- **Runtime:** Node.js 20+ with TypeScript
- **PDF:** MuPDF + Tesseract.js (OCR fallback)
- **Video:** ffmpeg + Whisper.cpp (local speech-to-text)
- **Embeddings:** HuggingFace Transformers (local, no API)
- **LLM:** OpenRouter (free tier)
- **Auth:** Supabase

## Free Tier Setup

This backend is designed to run entirely on free tiers:

- OpenRouter: `meta-llama/llama-3.3-70b-instruct:free`
- Supabase: Free auth + 500MB database
- Railway: $5 credit/month (free for light usage)
