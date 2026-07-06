import os
import asyncio
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")
from groq import Groq

# Central LLM model config. Change this one value (or the GROQ_LLM_MODEL env var)
# to swap the model everywhere. Replaces deprecated llama-3.3-70b-versatile.
GROQ_LLM_MODEL = os.getenv("GROQ_LLM_MODEL", "openai/gpt-oss-120b")


def llm_call_kwargs() -> dict:
    """
    Extra kwargs for chat.completions.create that depend on the model family.

    GPT-OSS models are *reasoning* models: by default they spend part of the
    token budget "thinking", which (a) adds latency and (b) can starve the
    visible answer — returning empty strings or "please provide the text"
    refusals on short inputs. Forcing reasoning_effort=low keeps them fast and
    makes them answer directly. Harmless no-op for non-reasoning models, which
    is why we only attach it for gpt-oss.
    """
    if "gpt-oss" in GROQ_LLM_MODEL:
        return {"extra_body": {"reasoning_effort": "low"}}
    return {}


async def stream_chat(system: str, user: str, temperature: float = 0.3, max_tokens: int = 1024):
    """
    Async generator that yields tokens from a streamed chat completion.
    The blocking Groq stream runs in a thread and pipes tokens back through an
    asyncio.Queue so the event loop is never blocked. Shared by Study & RAG chat.
    """
    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def worker():
        try:
            stream = client.chat.completions.create(
                model=GROQ_LLM_MODEL,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                temperature=temperature,
                max_tokens=max_tokens,
                stream=True,
                **llm_call_kwargs(),
            )
            for chunk in stream:
                tok = chunk.choices[0].delta.content
                if tok:
                    loop.call_soon_threadsafe(queue.put_nowait, tok)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    loop.run_in_executor(None, worker)
    while True:
        tok = await queue.get()
        if tok is None:
            break
        yield tok
