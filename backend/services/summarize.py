import os, asyncio
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")
from groq import Groq

async def summarize_text(text: str) -> str:
    client = Groq(api_key=os.getenv("GROQ_API_KEY"))

    def _call():
        return client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are an expert at summarizing spoken content. "
                        "Given a speech transcript, provide:\n"
                        "1. A concise 2-3 sentence summary\n"
                        "2. 3-4 key bullet points as speaker notes\n\n"
                        "Format exactly like:\n"
                        "SUMMARY: <summary>\nNOTES:\n• <point 1>\n• <point 2>\n• <point 3>"
                    ),
                },
                {"role": "user", "content": f"Transcript:\n{text}"},
            ],
            temperature=0.3,
            max_tokens=512,
        )

    # FIX: use get_running_loop() instead of deprecated get_event_loop()
    loop = asyncio.get_running_loop()
    response = await loop.run_in_executor(None, _call)
    return response.choices[0].message.content.strip()