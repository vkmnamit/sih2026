# Eklavya Backend — Complete API Reference

> **100% TypeScript** · Express 5 · Supabase Auth · RAG (HuggingFace + OpenRouter) · MuPDF PDF · Whisper Audio

---

## Table of Contents

1. [Tech Stack](#tech-stack)
2. [Project Structure](#project-structure)
3. [Environment Setup](#environment-setup)
4. [Running the Server](#running-the-server)
5. [How the System Works](#how-the-system-works)
6. [API Endpoints](#api-endpoints)
   - [GET /health](#get-health)
   - [POST /api/auth/signup](#post-apiauthsignup)
   - [POST /api/auth/login](#post-apiauthlogin)
   - [GET /api/auth/me](#get-apiauthme)
   - [POST /api/ingest/pdf](#post-apiingestpdf)
   - [POST /api/ingest/video](#post-apiingestvideo)
   - [POST /api/ingest](#post-apiingest)
   - [POST /api/ask](#post-apiask)
   - [GET /api/ask/_stats](#get-apiask_stats)
   - [GET /api/cards](#get-apicards)
   - [POST /api/cards/generate](#post-apicardsgenerate)
7. [Middleware Chain](#middleware-chain)
8. [Error Handling](#error-handling)
9. [Roles and Authorization](#roles-and-authorization)
10. [Pipeline Deep Dives](#pipeline-deep-dives)

---

## Tech Stack

| Layer | Library |
|---|---|
| Server | Express 5 |
| Language | TypeScript 7 (strict mode, NodeNext modules) |
| Auth | Supabase Auth (email + password, JWT) |
| PDF extraction | MuPDF (`mupdf` npm) + OCR fallback via `tesseract.js` |
| Audio/Video | `nodejs-whisper` (whisper.cpp binding) |
| Embeddings | `@huggingface/transformers` — local ONNX model, **no API key needed** |
| Vector store | JSON file on disk (`data/vector-store.json`) |
| LLM (chat) | OpenRouter API (`OPENROUTER_API_KEY`) |
| File uploads | `multer` (disk storage) |

---

## Project Structure

```
sih_2026/
├── src/
│   ├── server.ts                   # Entry point — boots Express, prints route list
│   ├── app.ts                      # Express factory (routes, static files, error handlers)
│   ├── config/
│   │   └── index.ts                # Typed config — reads .env, exports all settings
│   ├── routes/
│   │   ├── index.ts                # Mounts /auth /ingest /ask /cards under /api
│   │   ├── auth.routes.ts          # Auth routes (signup, login, me)
│   │   ├── ingest.routes.ts        # File ingestion routes
│   │   ├── ask.routes.ts           # RAG question-answering route
│   │   └── cards.routes.ts         # AI content cards routes
│   ├── controllers/
│   │   ├── auth.controller.ts      # HTTP handlers for auth (thin wrappers)
│   │   └── ingest.controller.ts    # HTTP handlers for PDF + video pipelines
│   ├── services/
│   │   ├── auth.service.ts         # Supabase Auth: signup, login, verifyToken, getProfile
│   │   ├── pdf.service.ts          # MuPDF text extraction + per-page OCR fallback
│   │   ├── video.service.ts        # ffmpeg audio strip + Whisper transcription
│   │   ├── whisper.service.ts      # nodejs-whisper wrapper
│   │   ├── chunking.service.ts     # Splits segments into overlapping text chunks
│   │   ├── embedding.service.ts    # Local HuggingFace ONNX embeddings
│   │   ├── vector-store.service.ts # In-memory + JSON-persisted vector DB
│   │   ├── rag.service.ts          # RAG orchestrator: embed -> search -> LLM -> answer
│   │   ├── llm.service.ts          # OpenRouter chat completion wrapper
│   │   ├── content-cards.service.ts# AI content card generation (post + carousel)
│   │   └── supabase.service.ts     # Supabase data layer (cards, docs, uploads tables)
│   ├── middleware/
│   │   ├── auth.middleware.ts      # requireAuth (JWT verify) + requireRole
│   │   ├── upload.middleware.ts    # multer disk storage with size limits
│   │   ├── validate.middleware.ts  # requireFile, validateExtension, HttpError
│   │   └── error.middleware.ts     # Global JSON error handler + 404 handler
│   └── types/
│       ├── auth.ts                 # UserRole, Profile, AuthResponse, SignupBody, LoginBody
│       └── ingest.ts               # Chunk, Segment, VectorDoc, AskResponse, CardsResponse
├── tests/                          # TypeScript test helpers + fixtures
├── public/                         # Static HTML test frontend (served at /)
├── supabase/                       # SQL migration files
├── uploads/                        # Temporary staging for uploaded files (auto-deleted)
├── data/                           # Persisted vector store JSON
├── .env                            # Your secret keys (never commit this)
├── .env.example                    # Template for .env
├── package.json
└── tsconfig.json
```

---

## Environment Setup

Copy `.env.example` to `.env` and fill in the values:

```env
# LLM — chat completions only (embeddings are local and FREE)
OPENROUTER_API_KEY="sk-or-v1-..."
OPENROUTER_MODEL=openrouter/free

# Supabase — required for auth endpoints
supabase-project-id="https://xxxx.supabase.co"
supabase-anon-key="sb_publishable_..."
supabase-service-key="sb_secret_..."

# Optional tuning
# PORT=3000
# MAX_UPLOAD_MB=500
# RAG_TOP_K=5
# EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
# WHISPER_MODEL=base.en
# CARDS_DEPTH=2
# CHUNKS_PER_CARD=4
```

**Supabase setup required:**
1. Go to Supabase Dashboard -> Authentication -> Settings
2. Under **Email Auth**, disable "Confirm email" (or configure SMTP)
3. Add `http://localhost:3000` to **Site URL** and **Redirect URLs**

---

## Running the Server

```bash
npm install       # install dependencies
npm run dev       # development: tsx watch (hot-reload, no build step needed)
npm run build     # compile TypeScript -> dist/ (production only)
npm start         # run compiled dist/server.js
```

Server starts at `http://localhost:3000` by default.

---

## How the System Works

```
Client
  |
  |-- POST /api/auth/signup ──────────────────────> Supabase Auth
  |-- POST /api/auth/login  ──────────────────────> Supabase Auth (JWT returned)
  |
  |-- POST /api/ingest/pdf  --> multer -> MuPDF extract -> OCR fallback
  |                             -> chunker -> local embeddings -> vector store
  |                             -> [background] LLM -> AI content cards
  |
  |-- POST /api/ingest/video -> multer -> ffmpeg strip audio -> Whisper transcribe
  |                             -> chunker -> local embeddings -> vector store
  |                             -> [background] LLM -> AI content cards
  |
  |-- POST /api/ask ─────────> local embed query -> vector search (cosine)
  |                             -> top-K chunks -> OpenRouter LLM -> grounded answer
  |
  |-- GET  /api/cards ───────> cached cards from memory
  |-- POST /api/cards/generate> LLM generates post/carousel cards for a source
```

---

## API Endpoints

### GET /health

Health check. No auth required.

**Response 200:**
```json
{
  "ok": true,
  "service": "eklavya-backend",
  "time": "2026-08-31T15:00:00.000Z"
}
```

---

### POST /api/auth/signup

Create a new user account. Role is stored in Supabase Auth `user_metadata` AND in the `profiles` table.

**Auth required:** No

**Request body (JSON):**
```json
{
  "email": "student@example.com",
  "password": "securepassword",
  "role": "trainee",
  "name": "Namit Raj"
}
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `email` | string | YES | Valid email address |
| `password` | string | YES | Minimum 6 characters |
| `role` | string | YES | One of: `admin`, `trainer`, `trainee` |
| `name` | string | NO | Optional display name |

**Response 201 — Success:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "...",
  "token_type": "bearer",
  "expires_in": 3600,
  "user": {
    "id": "uuid-here",
    "email": "student@example.com",
    "role": "trainee",
    "name": "Namit Raj"
  }
}
```

**Error responses:**

| HTTP | Condition | error message |
|---|---|---|
| 400 | Missing email | `email is required.` |
| 400 | Weak password | `password must be at least 6 characters.` |
| 400 | Invalid role | `role must be one of: admin, trainer, trainee` |
| 503 | Supabase not configured | `Auth is not configured on this server.` |
| 500 | Supabase error | `Signup failed: <supabase error>` |

**Internal flow:**
1. Controller validates `email`, `password`, `role`
2. Calls `auth.service.ts` -> `signup()` -> `supabase.auth.signUp()`
3. Role + name stored in `user_metadata`
4. Profile row upserted into `profiles` table (`id`, `email`, `role`, `name`)
5. JWT tokens returned immediately

---

### POST /api/auth/login

Log in with email and password. Returns JWT tokens and user profile.

**Auth required:** No

**Request body (JSON):**
```json
{
  "email": "student@example.com",
  "password": "securepassword"
}
```

| Field | Type | Required |
|---|---|---|
| `email` | string | YES |
| `password` | string | YES |

**Response 200 — Success:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "...",
  "token_type": "bearer",
  "expires_in": 3600,
  "user": {
    "id": "uuid-here",
    "email": "student@example.com",
    "role": "trainee",
    "name": "Namit Raj"
  }
}
```

**Error responses:**

| HTTP | Condition | error message |
|---|---|---|
| 400 | Missing email | `email is required.` |
| 400 | Missing password | `password is required.` |
| 503 | Supabase not configured | `Auth is not configured on this server.` |
| 500 | Wrong credentials | `Login failed: Invalid login credentials` |

**How to use the token in all subsequent requests:**
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Internal flow:**
1. Controller validates `email` and `password` are present strings
2. Calls `auth.service.ts` -> `login()` -> `supabase.auth.signInWithPassword()`
3. Role fetched from `profiles` table (fallback: `'trainee'`)
4. Returns session tokens + enriched user object

---

### GET /api/auth/me

Returns the current authenticated user's profile.

**Auth required:** YES — `Authorization: Bearer <token>`

**Response 200:**
```json
{
  "id": "uuid-here",
  "email": "student@example.com",
  "role": "trainee",
  "name": "Namit Raj"
}
```

**Error responses:**

| HTTP | Condition | error message |
|---|---|---|
| 401 | No / malformed token | `Missing or malformed Authorization header.` |
| 401 | Expired / invalid token | `Invalid or expired token.` |
| 401 | No user attached | `Not authenticated.` |

**Internal flow:**
1. `requireAuth` middleware extracts `Bearer` token from `Authorization` header
2. `verifyToken()` -> `supabase.auth.getUser(token)`
3. Role fetched from `profiles` table, attached to `req.user`
4. Controller fetches full profile via `getProfile(req.user.id)` and returns it

---

### POST /api/ingest/pdf

Upload a PDF file. Extracts text page-by-page (MuPDF), falls back to OCR on scanned/image pages, chunks the text, and indexes it into the vector store for RAG.

**Auth required:** No

**Request:** `multipart/form-data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `file` | file | YES | Must be `.pdf`. Max: `MAX_UPLOAD_MB` (default 500 MB) |

**cURL example:**
```bash
curl -X POST http://localhost:3000/api/ingest/pdf \
  -F "file=@/path/to/lecture-notes.pdf"
```

**Response 200 — Success:**
```json
{
  "ok": true,
  "type": "pdf",
  "fileName": "lecture-notes.pdf",
  "stats": {
    "pages": 12,
    "ocrUsed": false,
    "chunks": 38
  },
  "chunks": [
    {
      "text": "Binary search is an algorithm...",
      "meta": {
        "page": 1,
        "pageEnd": 2,
        "extraction": "mupdf"
      }
    }
  ],
  "indexed": 38
}
```

| Response field | Meaning |
|---|---|
| `stats.pages` | Total pages processed |
| `stats.ocrUsed` | `true` if at least one page was scanned (OCR was used) |
| `stats.chunks` | Total text chunks generated |
| `chunks` | Full array of text chunks with page metadata |
| `indexed` | Chunks successfully stored in vector DB |

**Error responses:**

| HTTP | Condition |
|---|---|
| 400 | No file uploaded |
| 400 | File is not a `.pdf` |
| 413 | File exceeds size limit |
| 500 | MuPDF or OCR processing failure |

**Internal pipeline (step by step):**
```
multer (disk storage)
  -> file saved to uploads/ as <timestamp>_<random>.pdf
      -> pdf.service.ts: extractPdfSegments()
           -> MuPDF reads each page, extracts text characters
           -> If page has < 30 alphanumeric chars: OCR path
                -> Rasterize page at 3x scale (~216 DPI)
                -> tesseract.js OCR with eng.traineddata model
                     -> chunking.service.ts: chunkSegments()
                          -> 1200-char chunks, 150-char overlap
                               -> rag.service.ts: indexChunks()
                                    -> embedding.service.ts: embedTexts() [local ONNX]
                                         -> vector-store.service.ts: addChunks()
                                              -> saved to data/vector-store.json
                                                   -> [background] AI card generation starts
```

> The staged file in `uploads/` is ALWAYS deleted after pipeline finishes, even on error.

---

### POST /api/ingest/video

Upload a video or audio file. Strips audio with ffmpeg, transcribes with Whisper (timestamped), chunks, and indexes.

**Auth required:** No

**Request:** `multipart/form-data`

| Field | Allowed extensions |
|---|---|
| `file` | `.mp4` `.mov` `.mkv` `.avi` `.webm` `.mp3` `.wav` `.m4a` `.aac` `.ogg` `.flac` |

**cURL example:**
```bash
curl -X POST http://localhost:3000/api/ingest/video \
  -F "file=@/path/to/lecture.mp4"
```

**Response 200 — Success:**
```json
{
  "ok": true,
  "type": "video",
  "fileName": "lecture.mp4",
  "stats": {
    "segments": 47,
    "durationSec": 3620,
    "chunks": 52
  },
  "chunks": [
    {
      "text": "Today we will cover sorting algorithms...",
      "meta": {
        "startSec": 0,
        "endSec": 45.2,
        "extraction": "whisper"
      }
    }
  ],
  "indexed": 52
}
```

| Response field | Meaning |
|---|---|
| `stats.segments` | Whisper transcript segment count |
| `stats.durationSec` | Total audio duration in seconds |
| `stats.chunks` | Total text chunks generated |
| `indexed` | Chunks stored in vector DB |

**Internal pipeline (step by step):**
```
multer (disk storage)
  -> file saved to uploads/
      -> video.service.ts: extractVideoSegments()
           -> ffmpeg: extract audio -> 16kHz mono PCM WAV
                -> whisper.service.ts: transcribeAudio()
                     -> nodejs-whisper (model: base.en)
                          -> transcript segments with startSec, endSec, text
                               -> chunking.service.ts: chunkSegments()
                                    -> 1200-char chunks, 150-char overlap
                                         -> rag.service.ts: indexChunks()
                                              -> local ONNX embeddings -> vector-store.json
```

---

### POST /api/ingest

Auto-detect PDF vs video/audio by file extension and route to the correct pipeline.

**Auth required:** No

**Request:** `multipart/form-data` — `file` field, any allowed extension

**Response:** Same as `/api/ingest/pdf` or `/api/ingest/video`

**Error responses:**

| HTTP | Condition |
|---|---|
| 400 | No file uploaded |
| 400 | Unsupported file extension |

---

### POST /api/ask

Ask a question in natural language. Embeds the question, retrieves the most relevant chunks, and uses an LLM to generate a grounded answer with page/timestamp citations.

**Auth required:** No

**Request body (JSON):**
```json
{
  "question": "Explain how binary search works",
  "source": "lecture-notes.pdf"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `question` | string | YES | The student's question |
| `source` | string | NO | Scope search to one uploaded file only |

**cURL example:**
```bash
curl -X POST http://localhost:3000/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "What is binary search?"}'
```

**Response 200 — LLM answer:**
```json
{
  "ok": true,
  "question": "What is binary search?",
  "grounded": true,
  "model": "meta-llama/llama-3.3-70b-instruct:free",
  "answer": "Binary search is an efficient algorithm [source: lecture-notes.pdf · page 3]...",
  "sources": [
    {
      "source": "lecture-notes.pdf",
      "page": 3,
      "pageEnd": 4,
      "extraction": "mupdf",
      "score": 0.9234,
      "snippet": "Binary search is an algorithm that finds the position..."
    }
  ]
}
```

**Response 200 — No LLM key (extractive fallback):**
```json
{
  "ok": true,
  "question": "What is binary search?",
  "grounded": false,
  "model": "retrieval-only",
  "answer": "No LLM key configured — showing raw retrieved material:\n\n...",
  "sources": [...]
}
```

**Response 200 — No content indexed yet:**
```json
{
  "ok": true,
  "question": "What is binary search?",
  "grounded": false,
  "model": "none",
  "answer": "No indexed content found yet. Upload a PDF or video first.",
  "sources": []
}
```

| Response field | Meaning |
|---|---|
| `grounded` | `true` = LLM answer; `false` = raw retrieval |
| `model` | Model used, or `"none"` / `"retrieval-only"` |
| `sources[].score` | Cosine similarity (0-1, higher = more relevant) |
| `sources[].snippet` | First 240 chars of the matched chunk |
| `sources[].page` | Page number (PDF only) |
| `sources[].startSec` | Start time in seconds (video only) |

**Internal flow (step by step):**
```
question string
  -> embedding.service.ts: embedText() -> 384-dim vector [local ONNX, no API key]
       -> vector-store.service.ts: search(vector, topK=5)
            -> cosine similarity against every indexed chunk
                 -> top-5 most relevant chunks with scores
                      -> llm.service.ts: chatComplete() [OpenRouter API]
                           -> System: "You are Eklavya, a patient AI tutor..."
                           -> User: numbered chunks as context + student question
                                -> grounded answer with inline citations
```

---

### GET /api/ask/_stats

Returns vector store statistics.

**Auth required:** No

**Response 200:**
```json
{
  "ok": true,
  "totalDocs": 90,
  "sources": ["lecture-notes.pdf", "module2.mp4"]
}
```

---

### GET /api/cards

Get all generated AI content cards, with optional filtering.

**Auth required:** No

**Query parameters:**

| Param | Type | Description |
|---|---|---|
| `source` | string | Filter by file name e.g. `?source=lecture-notes.pdf` |
| `format` | string | Filter by card type: `post` or `carousel` |

**Examples:**
```
GET /api/cards                                  # all cards
GET /api/cards?source=lecture-notes.pdf         # cards for one file
GET /api/cards?format=carousel                  # carousel-format only
GET /api/cards?source=notes.pdf&format=post     # both filters combined
```

**Response 200:**
```json
{
  "ok": true,
  "source": "lecture-notes.pdf",
  "cards": [
    {
      "source": "lecture-notes.pdf",
      "format": "carousel",
      "name": "Binary Search",
      "category": "ALGORITHMS",
      "heading": "Divide and",
      "headingHighlight": "Conquer",
      "description": "Binary search splits the search space in half each iteration.",
      "events": [
        { "date": "Step 1", "title": "Set bounds", "description": "Low=0, High=n-1", "important": true }
      ],
      "takeaway": {
        "label": "Key Takeaway",
        "text": "Time complexity is O(log n)"
      }
    }
  ]
}
```

---

### POST /api/cards/generate

Trigger AI generation of content cards for a previously ingested source file.

> **Note:** Cards are also auto-generated in the background after every successful ingest — you usually do not need to call this manually.

**Auth required:** No

**Request body (JSON):**
```json
{
  "source": "lecture-notes.pdf",
  "depth": 2,
  "format": "carousel"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `source` | string | YES | File name exactly as uploaded |
| `depth` | number | NO | `1` = one card per topic; `2` = whole-chapter (default) |
| `format` | string | NO | `"post"` (default) or `"carousel"` |

**Depth explained:**
- **`depth: 1`** — One card per major topic and subtopic (fast)
- **`depth: 2`** — Big chapters split into multiple ordered cards covering every section (thorough)

**Response 200:**
```json
{
  "ok": true,
  "source": "lecture-notes.pdf",
  "cards": [ ...generated cards... ]
}
```

**Error responses:**

| HTTP | Condition |
|---|---|
| 400 | Missing `source` field |
| 400 | `depth` is not `1` or `2` |

**Internal flow:**
```
source name
  -> vector-store.service.ts: getDocsBySource() -> all chunks for this file
       -> content-cards.service.ts: generateCardsForSource()
            -> llm.service.ts: chatComplete() per topic/chunk window
                 -> LLM returns structured card JSON
                      -> cached in memory + persisted to data/content-cards.json
```

---

## Middleware Chain

```
Request arrives
  |
  |-- express.json()          # parse JSON body (1 MB limit)
  |-- express.static()        # serve public/ HTML test frontend
  |
  |-- GET /health             # no middleware, bypasses everything
  |
  |-- /api/*
       |-- [ingest routes] uploadSingle (multer)  # save file to disk
       |-- [ingest routes] requireFile            # 400 if no file
       |-- [ingest routes] validateExtension      # 400 if wrong type
       |
       |-- [protected routes] requireAuth         # extract + verify JWT
       |    -> supabase.auth.getUser(token)
       |    -> req.user = { id, email, role }
       |
       |-- controller / route handler
       |
       |-- notFoundHandler    # 404 JSON for unknown routes
       |-- errorHandler       # catch-all: errors -> consistent JSON
```

---

## Error Handling

All errors always return:
```json
{
  "ok": false,
  "error": "Human-readable message here"
}
```

| HTTP Status | When |
|---|---|
| 400 | Bad request — missing field, wrong type, invalid extension |
| 401 | Missing or invalid auth token |
| 403 | Authenticated but wrong role |
| 404 | Route does not exist |
| 413 | File too large |
| 503 | Supabase not configured in `.env` |
| 500 | Unexpected server-side error |

- Errors >= 500: logged with full stack trace to console
- Errors < 500: only message logged (no stack trace noise)

---

## Roles and Authorization

| Role | Description |
|---|---|
| `admin` | Full platform management |
| `trainer` | Creates/manages content, views trainee progress |
| `trainee` | Consumes content, takes assessments |

**Protecting routes with `requireRole`:**
```typescript
// Only admin and trainer allowed
router.post('/content', requireAuth, requireRole('admin', 'trainer'), handler);
```

---

## Pipeline Deep Dives

### PDF Pipeline

```
PDF file
  |-- MuPDF reads each page
  |    |-- Extracts raw text characters
  |    |-- If page has < 30 alphanumeric chars -> OCR path:
  |         |-- Rasterize page at 3x scale (~216 DPI)
  |         |-- tesseract.js OCR (English: eng.traineddata)
  |
  |-- All pages -> segments[] (text + { page, extraction: 'mupdf'|'ocr' })
       |-- chunking.service.ts
            |-- maxChars: 1200 chars per chunk
            |-- overlapChars: 150 chars overlap between chunks
            |-- chunks[] (text + { page, pageEnd, extraction })
```

### Video/Audio Pipeline

```
Video/Audio file
  |-- video.service.ts
       |-- ffmpeg: extract audio -> 16kHz mono PCM WAV
       |-- whisper.service.ts (nodejs-whisper, model: base.en)
            |-- transcript segments[] (text + { startSec, endSec })
                 |-- chunking.service.ts -> same 1200/150 char chunker
```

### RAG Pipeline

```
Question string
  |-- embedding.service.ts: embedText()
       |-- HuggingFace Xenova/all-MiniLM-L6-v2 (local ONNX, no API key)
            |-- 384-dimensional float vector
                 |-- vector-store.service.ts: search(vector, topK=5)
                      |-- cosine similarity against all indexed chunks
                           |-- top 5 most relevant chunks with scores
                                |-- llm.service.ts: chatComplete() [OpenRouter]
                                     |-- System: "You are Eklavya, a patient AI tutor..."
                                     |-- Context: numbered chunks with source citations
                                     |-- OpenRouter API -> grounded answer with citations
```
