#!/usr/bin/env python3
"""Generates assets/ring.wav — the incoming-call tone.

Written out rather than downloaded because these users' phones cannot reach a
sound library, and a stock Android ringtone is exactly what an incoming call
must NOT sound like: it has to be recognisable as THIS app across a room.

The tone is an FM bell — a sine carrier with a sine modulator an octave up,
whose index decays fast — struck as a rising four-note phrase over a soft
sustained fifth, then answered by the same phrase a fourth higher. That is the
"telephone" shape (a call, an answer) without copying any particular one.

Deliberate choices:
  * A5-C6 region for the melody: small phone speakers roll off below ~400 Hz,
    so a low tone that sounds warm on a laptop is inaudible in a pocket.
  * Every note is enveloped to silence and the whole phrase fades in and out,
    so looping it — which is what a call does — has no click at the seam.
  * ~6 s per cycle, four cycles: long enough that a notification channel plays
    a real ring rather than a chime, short enough to stop being pleasant before
    it stops being polite.

Run: python3 native-app/assets/make-ring.py
"""
import math
import struct
import wave

SR = 44100


def env(n, attack, decay):
    """Percussive envelope: a fast rise, an exponential fall to true zero."""
    out = []
    a = max(1, int(attack * SR))
    for i in range(n):
        if i < a:
            e = i / a
        else:
            e = math.exp(-(i - a) / (decay * SR))
        out.append(e)
    # Pull the tail to zero so a note never ends on a step.
    tail = min(n, int(0.01 * SR))
    for i in range(tail):
        out[n - tail + i] *= 1 - i / tail
    return out


def bell(freq, dur, amp, ratio=2.0, index=3.2, decay=0.35):
    """One FM strike."""
    n = int(dur * SR)
    e = env(n, 0.004, decay)
    out = []
    for i in range(n):
        t = i / SR
        # The modulation index decays faster than the note: bright on the
        # strike, pure as it rings out. That is what makes it read as a bell
        # rather than as a buzz.
        idx = index * math.exp(-t / (decay * 0.6))
        mod = idx * math.sin(2 * math.pi * freq * ratio * t)
        out.append(amp * e[i] * math.sin(2 * math.pi * freq * t + mod))
    return out


def pad(freq, dur, amp):
    """A soft sustained tone under the phrase, so it is not four bare pings."""
    n = int(dur * SR)
    out = []
    for i in range(n):
        t = i / SR
        # Slow swell in and out across the whole note.
        e = math.sin(math.pi * min(1.0, i / n)) ** 1.5
        v = math.sin(2 * math.pi * freq * t) * 0.75 + math.sin(2 * math.pi * freq * 2 * t) * 0.25
        out.append(amp * e * v)
    return out


def mix(buf, part, at):
    start = int(at * SR)
    need = start + len(part)
    if need > len(buf):
        buf.extend([0.0] * (need - len(buf)))
    for i, v in enumerate(part):
        buf[start + i] += v


def semitone(base, n):
    return base * (2 ** (n / 12))


A5 = 880.0
CYCLE = 6.0
CYCLES = 3

buf = []
for c in range(CYCLES):
    t0 = c * CYCLE
    # Phrase one: a rising call. Phrase two answers it a fourth higher.
    for phrase, (shift, when) in enumerate(((0, 0.0), (5, 1.6))):
        base = semitone(A5, shift)
        mix(buf, pad(base / 2, 1.25, 0.055), t0 + when)
        for i, step in enumerate((0, 4, 7, 12)):
            mix(buf,
                bell(semitone(base, step), 0.9, 0.30 if i < 3 else 0.34,
                     decay=0.30 if i < 3 else 0.42),
                t0 + when + i * 0.19)
    # …then silence, which is half of what makes a ring a ring.

# Fade the very start and end of the whole file, for the seam on repeat.
edge = int(0.03 * SR)
for i in range(min(edge, len(buf))):
    buf[i] *= i / edge
    buf[len(buf) - 1 - i] *= i / edge

peak = max(abs(v) for v in buf) or 1.0
# -1 dBFS. Loud, because it is competing with a pocket.
scale = 0.89 / peak
frames = b''.join(struct.pack('<h', int(max(-1.0, min(1.0, v * scale)) * 32767)) for v in buf)

with wave.open('native-app/assets/ring.wav', 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(frames)
print(f'ring.wav: {len(buf) / SR:.1f}s, {len(frames) / 1024:.0f} KiB')
