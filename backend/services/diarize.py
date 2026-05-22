"""
diarize.py — PolyglotAI Speaker Diarization Service
=====================================================
WHAT THIS DOES:
  Takes an audio file and identifies WHO is speaking WHEN.
  Output looks like:
    Speaker 1: "Good morning everyone"
    Speaker 2: "Thanks for joining the call"
    Speaker 1: "Let's get started"

HOW IT WORKS:
  1. pyannote-audio runs speaker diarization → finds time segments per speaker
  2. Whisper transcribes the full audio with timestamps
  3. We match each transcript word/segment to the right speaker by time
  4. Output is a clean labelled dialogue

SETUP (one time):
  1. Go to https://huggingface.co/pyannote/speaker-diarization-3.1
     Click "Agree" to accept the model license
  2. Go to https://huggingface.co/settings/tokens
     Create a token (read access is enough)
  3. Add to Render environment:
     HF_TOKEN = hf_xxxxxxxxxxxxxxxxxx

Add to requirements.txt:
  pyannote.audio==3.3.2
  torch==2.2.2
  torchaudio==2.2.2
"""

import os, io, tempfile, asyncio, logging
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env")

logger = logging.getLogger(__name__)

# Lazy load — these are large libraries, only import when actually needed
_pipeline = None

def _get_pipeline():
    """
    Load pyannote diarization pipeline.
    Lazy loaded so app startup is fast.
    Model is cached after first load.
    """
    global _pipeline
    if _pipeline is not None:
        return _pipeline

    hf_token = os.getenv("HF_TOKEN")
    if not hf_token:
        raise RuntimeError("HF_TOKEN not set. Add your HuggingFace token in Render environment variables.")

    from pyannote.audio import Pipeline
    logger.info("Loading pyannote diarization model (first time takes ~30 seconds)...")
    _pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=hf_token
    )
    logger.info("Diarization model loaded.")
    return _pipeline


async def diarize_audio(audio_bytes: bytes, filename: str, transcript_segments: list) -> list:
    """
    Run speaker diarization on audio and match to transcript segments.

    Args:
        audio_bytes:          raw audio file bytes
        filename:             original filename (used for extension)
        transcript_segments:  list of Whisper segments:
                              [{"start": 0.0, "end": 2.5, "text": "Hello everyone"}, ...]

    Returns:
        list of diarized segments:
        [
          {"speaker": "Speaker 1", "start": 0.0, "end": 2.5, "text": "Hello everyone"},
          {"speaker": "Speaker 2", "start": 3.1, "end": 5.0, "text": "Thanks for joining"},
          ...
        ]
    """
    loop = asyncio.get_running_loop()

    def _run():
        import torch

        pipeline = _get_pipeline()

        # Write audio to a temp file — pyannote needs a file path, not bytes
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "wav"
        with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        try:
            # Run diarization — returns a pyannote Annotation object
            # num_speakers=None means auto-detect how many speakers there are
            diarization = pipeline(tmp_path, num_speakers=None)

            # Convert pyannote output to simple list of time segments
            # Each segment: (start_time, end_time, speaker_label)
            speaker_segments = []
            for turn, _, speaker in diarization.itertracks(yield_label=True):
                speaker_segments.append({
                    "start":   round(turn.start, 2),
                    "end":     round(turn.end,   2),
                    "speaker": speaker   # e.g. "SPEAKER_00", "SPEAKER_01"
                })

            # Match each Whisper transcript segment to a speaker
            # by finding which speaker segment overlaps most with the transcript time
            result = []
            for seg in transcript_segments:
                seg_start = seg.get("start", 0)
                seg_end   = seg.get("end",   0)
                text      = seg.get("text",  "").strip()

                if not text:
                    continue

                # Find best matching speaker by overlap
                best_speaker = "Speaker 1"
                best_overlap = 0.0

                for sp in speaker_segments:
                    # Calculate overlap between transcript segment and speaker segment
                    overlap_start = max(seg_start, sp["start"])
                    overlap_end   = min(seg_end,   sp["end"])
                    overlap       = max(0.0, overlap_end - overlap_start)

                    if overlap > best_overlap:
                        best_overlap = overlap
                        best_speaker = sp["speaker"]

                # Convert "SPEAKER_00" → "Speaker 1" for clean display
                speaker_label = _format_speaker(best_speaker)

                result.append({
                    "speaker": speaker_label,
                    "start":   seg_start,
                    "end":     seg_end,
                    "text":    text,
                })

            return result

        finally:
            # Always clean up temp file
            Path(tmp_path).unlink(missing_ok=True)

    return await loop.run_in_executor(None, _run)


def _format_speaker(raw_label: str) -> str:
    """
    Convert pyannote speaker labels to friendly names.
    "SPEAKER_00" → "Speaker 1"
    "SPEAKER_01" → "Speaker 2"
    """
    try:
        num = int(raw_label.split("_")[-1])
        return f"Speaker {num + 1}"
    except Exception:
        return raw_label


def format_diarized_transcript(segments: list) -> str:
    """
    Format diarized segments as a readable dialogue string.

    Input:
        [{"speaker": "Speaker 1", "text": "Hello"}, {"speaker": "Speaker 2", "text": "Hi"}]

    Output:
        Speaker 1: Hello
        Speaker 2: Hi
    """
    if not segments:
        return ""

    lines = []
    current_speaker = None
    current_text    = []

    for seg in segments:
        speaker = seg["speaker"]
        text    = seg["text"].strip()

        if speaker == current_speaker:
            # Same speaker continuing — merge into one block
            current_text.append(text)
        else:
            # Speaker changed — flush previous block
            if current_speaker and current_text:
                lines.append(f"{current_speaker}: {' '.join(current_text)}")
            current_speaker = speaker
            current_text    = [text]

    # Flush last block
    if current_speaker and current_text:
        lines.append(f"{current_speaker}: {' '.join(current_text)}")

    return "\n".join(lines)