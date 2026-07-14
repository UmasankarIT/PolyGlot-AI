"""
keywords.py — PolyglotAI Keyword & Topic Extraction
=====================================================
WHAT THIS DOES:
  Takes a transcript and extracts:
  1. Main topics  → broad themes (e.g. "Music", "Culture", "Technology")
  2. Keywords     → specific important words/phrases from the text
  3. One-line summary tag → very short description

HOW IT WORKS:
  LLaMA 3.3 70B reads the transcript and returns structured JSON
  with topics, keywords, and a short tag.

USED IN:
  - File Upload → shown as colored tags below transcript
  - Agent → always runs automatically after transcription
"""

import os, asyncio, json, logging
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env")
from groq import Groq
from backend.config import GROQ_LLM_MODEL, llm_call_kwargs

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are an expert at analyzing content and extracting the key CONCEPTS.

Given a transcript or document, return ONLY a valid JSON object:
{
  "topics": [<2-4 broad subject/theme strings, e.g. "Machine Learning", "Economics", "Biology">],
  "keywords": [<5-8 important CONCEPTS, technical terms, or ideas from the text>],
  "tag": <one short sentence (max 10 words) describing what this material is about>
}

STRICT RULES:
- Return ONLY valid JSON. No markdown, no explanation, no extra text.
- CRITICAL — GROUNDING: Only include topics and keywords that are ACTUALLY present or
  explicitly discussed IN THE PROVIDED TEXT. Do NOT add related, adjacent, or commonly
  associated concepts from your own background knowledge if they are not in the material.
  If a term (e.g. a specific algorithm or method) is not mentioned in the text, do not list it.
- Every keyword must be a term or phrase that appears in — or is directly described by — the text.
- topics must be broad subject areas or themes the text is genuinely about (1-2 words each).
- keywords must be CONCEPTS, technical terms, methods, or ideas the text actually covers.
- NEVER include names of people, authors, speakers, organizations, brands, places, or dates. Concepts only.
- Prefer fewer, accurate keywords over many speculative ones. It is better to return 4 grounded
  keywords than 8 that include guesses.
- tag must be under 10 words.
- Works for all languages — detect and extract in the same language as input.
"""

async def extract_keywords(text: str) -> dict:
    """
    Extract topics, keywords, and a short tag from transcript.
    
    Returns:
        {
            "topics":   ["Music", "Culture"],
            "keywords": ["originality", "style", "expression"],
            "tag":      "Speaker discusses music and personal style"
        }
    """
    if not text or len(text.strip()) < 10:
        return {"topics": [], "keywords": [], "tag": ""}

    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    safe_text = text[:6000] if len(text) > 6000 else text

    def _call():
        return client.chat.completions.create(
            model=GROQ_LLM_MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user",   "content": f"Extract from this transcript:\n\n{safe_text}"},
            ],
            temperature=0.1,
            max_tokens=512,
            response_format={"type": "json_object"},
            **llm_call_kwargs(),
        )

    try:
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _call)
        raw = response.choices[0].message.content.strip()
        result = json.loads(raw)
        return {
            "topics":   result.get("topics",   [])[:4],
            "keywords": result.get("keywords", [])[:8],
            "tag":      result.get("tag", ""),
        }
    except Exception as e:
        logger.warning(f"[Keywords] Extraction failed: {e}")
        return {"topics": [], "keywords": [], "tag": ""}