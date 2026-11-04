"""Audio validation and bounded speech chunks. No raw recordings are persisted."""

import io
import math
import sys
import wave
from array import array

from app.providers.errors import ProviderError


def validate_wav(data: bytes) -> None:
    """Reject silence before Whisper: even a zero-filled WAV can hallucinate words."""
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if wav.getsampwidth() != 2 or wav.getnchannels() != 1:
                raise ValueError("Expected mono 16-bit PCM")
            rate = wav.getframerate()
            if not 8000 <= rate <= 96000 or not 0.25 <= wav.getnframes() / rate <= 61:
                raise ValueError("Unsupported recording length or sample rate")
            samples = array("h", wav.readframes(wav.getnframes()))
    except (wave.Error, EOFError, ValueError) as exc:
        raise ProviderError(
            "Record up to 60 seconds of mono PCM audio and try again.", "invalid_audio", 422
        ) from exc
    if sys.byteorder != "little":
        samples.byteswap()
    block = rate // 50  # 20 ms windows; allow brief answers, reject silence and tiny clicks.
    voiced = sum(
        math.sqrt(sum(x * x for x in samples[i : i + block]) / block) / 32768 >= 0.008
        for i in range(0, len(samples) - block + 1, block)
    )
    if voiced < 6:
        raise ProviderError(
            "No speech was detected. Check the microphone input and try again.", "no_speech", 422
        )


def speech_chunks(text: str) -> list[str]:
    """Orpheus accepts 200 characters. Split on whitespace without losing any text."""
    remaining = text.strip()
    chunks = []
    while remaining:
        end = min(200, len(remaining))
        if end < len(remaining):
            space = remaining.rfind(" ", 0, end + 1)
            if space > 0:
                end = space
        chunks.append(remaining[:end])
        remaining = remaining[end:].lstrip()
    return chunks
