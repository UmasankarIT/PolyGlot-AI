"""
sentiment.py — PolyglotAI Sentiment Analysis Service
Uses Groq LLaMA 3.3 to detect emotion and tone in speech.
Real-world uses: customer service QA, interview analysis, meeting tone detection.
"""

import os, asyncio, json
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env")
from groq import Groq
from backend.config import GROQ_LLM_MODEL, llm_call_kwargs

SYSTEM_PROMPT = """You are an expert speech emotion and sentiment analyzer.

Analyze the emotional tone of the given text and return ONLY a valid JSON object:
{
  "sentiment": "positive" | "negative" | "neutral" | "mixed",
  "score": <float 0.0-1.0, strength of sentiment>,
  "confidence": <float 0.0-1.0>,
  "emotion": "joy" | "anger" | "sadness" | "fear" | "surprise" | "disgust" | "neutral" | "excitement" | "frustration" | "calm",
  "intensity": "low" | "medium" | "high",
  "key_phrases": [<up to 3 short phrases directly from the text>],
  "summary": <one concise sentence describing the emotional tone>
}

STRICT RULES:
- Return ONLY valid JSON. No markdown, no explanation, no extra text.
- key_phrases must be actual short phrases from the transcript (max 5 words each).
- Works for all languages including Telugu, Hindi, Tamil, Arabic, etc.
"""

async def analyze_sentiment(text: str) -> dict:
    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    safe_text = text[:8000] if len(text) > 8000 else text

    def _call():
        return client.chat.completions.create(
            model=GROQ_LLM_MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"Analyze:\n\n{safe_text}"},
            ],
            temperature=0.1,
            max_tokens=512,
            response_format={"type": "json_object"},
            **llm_call_kwargs(),
        )

    loop = asyncio.get_running_loop()
    response = await loop.run_in_executor(None, _call)
    raw = response.choices[0].message.content.strip()

    try:
        result = json.loads(raw)
        return {
            "sentiment":   result.get("sentiment", "neutral"),
            "score":       float(result.get("score", 0.5)),
            "confidence":  float(result.get("confidence", 0.7)),
            "emotion":     result.get("emotion", "neutral"),
            "intensity":   result.get("intensity", "medium"),
            "key_phrases": result.get("key_phrases", [])[:3],
            "summary":     result.get("summary", "Neutral tone detected."),
        }
    except Exception:
        return {
            "sentiment": "neutral", "score": 0.5, "confidence": 0.5,
            "emotion": "neutral", "intensity": "low", "key_phrases": [],
            "summary": "Could not analyze sentiment.",
        }