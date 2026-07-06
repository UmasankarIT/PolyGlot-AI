import os
import asyncio
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env")
from groq import Groq
from typing import AsyncGenerator
from backend.config import GROQ_LLM_MODEL, llm_call_kwargs

LANGUAGE_MAP = {
    "English": "English",
    "Hindi": "Hindi (Devanagari script)", "Telugu": "Telugu", "Tamil": "Tamil",
    "Kannada": "Kannada", "Malayalam": "Malayalam", "Bengali": "Bengali",
    "Marathi": "Marathi", "Gujarati": "Gujarati", "Punjabi": "Punjabi",
    "Spanish": "Spanish", "French": "French", "German": "German",
    "Italian": "Italian", "Portuguese": "Portuguese", "Dutch": "Dutch",
    "Russian": "Russian", "Japanese": "Japanese", "Korean": "Korean",
    "Chinese (Simplified)": "Simplified Chinese", "Arabic": "Arabic",
    "Turkish": "Turkish", "Polish": "Polish", "Swedish": "Swedish",
    "Greek": "Greek", "Hebrew": "Hebrew", "Thai": "Thai",
    "Vietnamese": "Vietnamese", "Indonesian": "Indonesian", "Swahili": "Swahili",
    "Urdu": "Urdu",
}

RTL_LANGUAGES = {"Arabic", "Hebrew", "Urdu"}

# FIX: max input characters to prevent LLaMA context overflow
MAX_INPUT_CHARS = 12_000

# Whisper hallucination phrases — silent/noisy chunks that Whisper invents
HALLUCINATION_PHRASES = {
    "thank you", "thanks", "thank you.", "thanks.", "thank you!",
    "obrigado", "obrigado.", "obrigada", "obrigada.",
    "gracias", "gracias.", "danke", "merci", "merci.", "arigatou",
    "tchau", "bye", "bye.", "goodbye", "hello", "hello.", "hi", "hi.",
    "yes", "no", "okay", "ok", ".", "..", "...", "you",
    "salam", "salam.", "ciao", "ciao.", "hai", "hai.",
}

def is_hallucination(text: str) -> bool:
    """Return True if this looks like a Whisper silence hallucination."""
    cleaned = text.strip().lower().rstrip(".!?,")
    return cleaned in HALLUCINATION_PHRASES or len(text.strip()) < 3

def _max_tokens(text: str) -> int:
    """
    Cap output tokens to prevent over-generating, but keep a generous floor:
    reasoning models (gpt-oss) need headroom beyond the visible answer or they
    return empty/refusal on short inputs. 256 floor fixes that at no real cost
    (max_tokens is a ceiling, not a target).
    """
    word_count = len(text.split())
    return max(256, min(word_count * 8, 2048))

def _truncate_input(text: str) -> str:
    """FIX: guard against extremely large inputs that exceed LLaMA context."""
    if len(text) > MAX_INPUT_CHARS:
        return text[:MAX_INPUT_CHARS] + "\n[... truncated for length]"
    return text

def _system_prompt(lang_full: str) -> str:
    return (
        f"You are a professional translation engine. Translate the user's text into {lang_full}. "
        "CRITICAL RULES: "
        "1. Output ONLY the translation — no notes, no explanation, no quotes, no preamble. "
        "2. Translate EVERYTHING you are given, even a single word, a fragment, or an "
        "incomplete sentence. If the input is one word, translate that one word. "
        "3. NEVER ask for clarification, NEVER say you need more text, NEVER refuse. "
        "4. Never repeat words, and never add words that were not in the original. "
        "5. Keep the translation about the same length as the input."
    )

async def translate_text(text: str, target_language: str) -> str:
    """Standard (non-streaming) translation. Runs sync Groq call off the event loop."""
    client    = Groq(api_key=os.getenv("GROQ_API_KEY"))
    lang_full = LANGUAGE_MAP.get(target_language, target_language)
    # FIX: truncate before sending
    safe_text = _truncate_input(text)

    def _call():
        return client.chat.completions.create(
            model=GROQ_LLM_MODEL,
            messages=[
                {"role": "system", "content": _system_prompt(lang_full)},
                {"role": "user",   "content": safe_text},
            ],
            temperature=0.1,
            max_tokens=_max_tokens(safe_text),
            **llm_call_kwargs(),
        )

    # FIX: use get_running_loop() instead of deprecated get_event_loop()
    loop = asyncio.get_running_loop()
    response = await loop.run_in_executor(None, _call)
    return response.choices[0].message.content.strip()

async def translate_text_stream(text: str, target_language: str) -> AsyncGenerator[str, None]:
    """
    Streaming translation — yields tokens as they arrive.
    Groq's sync for-loop runs in a thread executor; tokens are piped back
    via asyncio.Queue so the event loop is never blocked.
    """
    client    = Groq(api_key=os.getenv("GROQ_API_KEY"))
    lang_full = LANGUAGE_MAP.get(target_language, target_language)
    # FIX: truncate before sending
    safe_text = _truncate_input(text)
    # FIX: use get_running_loop() instead of deprecated get_event_loop()
    loop      = asyncio.get_running_loop()
    queue: asyncio.Queue[str | None] = asyncio.Queue()

    def _stream_to_queue():
        try:
            stream = client.chat.completions.create(
                model=GROQ_LLM_MODEL,
                messages=[
                    {"role": "system", "content": _system_prompt(lang_full)},
                    {"role": "user",   "content": safe_text},
                ],
                temperature=0.1,
                max_tokens=_max_tokens(safe_text),
                stream=True,
                **llm_call_kwargs(),
            )
            for chunk in stream:
                token = chunk.choices[0].delta.content
                if token:
                    loop.call_soon_threadsafe(queue.put_nowait, token)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)  # None = sentinel/done

    executor_task = loop.run_in_executor(None, _stream_to_queue)

    while True:
        token = await queue.get()
        if token is None:
            break
        yield token

    await executor_task  # surface any exception from the background thread