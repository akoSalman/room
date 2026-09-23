#!/usr/bin/env python3
"""
Generate ring.wav — the sound a phone makes for an incoming call.

── Why the old one was replaced ────────────────────────────────────────────

Reported as: "the sound of call ringtone is too much sharp". Measured before
changing anything, which is the only way to know whether a replacement is
actually softer or merely different:

    ring.wav (old)   centroid 1989 Hz   11% of energy above 2 kHz
                     strongest partials 1314, 1760 and 5281 Hz

A spectral centroid near 2 kHz sits in the band the ear is most sensitive to
(roughly 2–5 kHz, where the ear canal resonates), and a 5.3 kHz partial on top
of it is what "sharp" means. It was doing its job — a ringtone has to cut
through a pocket — but it cuts through a quiet room just as hard.

── What this makes instead ─────────────────────────────────────────────────

A soft bell, two notes, repeating with room to breathe:

  * fundamentals at 523 Hz and 392 Hz (C5 and G4), an interval that resolves
    downwards rather than alarming;
  * partials at 2x and 3x only, each far quieter than the one below it, and
    nothing above 1.6 kHz at all — so the centroid lands under 700 Hz;
  * a 45 ms attack rather than an instant one, which is most of the
    difference between "bell" and "beep";
  * a 1.3 s exponential decay, and 1.5 s of near-silence between phrases, so
    it is not a continuous tone pressing on the ear.

Still normalised to a real level — a ringtone nobody hears is a worse bug than
one that is too bright — but with a crest factor that leaves it feeling soft
rather than loud.

Run:  python3 make-ring.py
"""
import math
import struct
import wave

RATE = 44100
SECONDS = 15.0          # matches the old file, and the 30s cap on the push
PEAK = 0.62             # headroom left deliberately; see the docstring


def bell(freq, dur, attack=0.045, decay=1.3):
    """One soft bell note: three partials, gentle attack, long decay."""
    n = int(dur * RATE)
    out = [0.0] * n
    # Amplitude per partial. The drop is steep on purpose: it is the harmonics
    # above the fundamental that carry brightness, and a bell that keeps them
    # loud is a chime.
    partials = ((1.0, 1.0), (2.0, 0.22), (3.0, 0.07))
    for mult, amp in partials:
        f = freq * mult
        if f > 1600:        # nothing in the band that made the old one sharp
            continue
        w = 2 * math.pi * f / RATE
        for i in range(n):
            out[i] += amp * math.sin(w * i)
    atk = max(1, int(attack * RATE))
    for i in range(n):
        env = math.exp(-i / (decay * RATE))
        if i < atk:
            # A raised cosine, not a straight line: a linear attack still has
            # a corner in it, and a corner is a click.
            env *= 0.5 - 0.5 * math.cos(math.pi * i / atk)
        out[i] *= env
    return out


def build():
    total = int(SECONDS * RATE)
    buf = [0.0] * total
    phrase = 0.0
    while phrase < SECONDS:
        # Two notes, the second a fourth below, 0.42 s apart.
        for offset, freq in ((0.0, 523.25), (0.42, 392.00)):
            start = int((phrase + offset) * RATE)
            note = bell(freq, 1.6)
            for i, v in enumerate(note):
                j = start + i
                if j >= total:
                    break
                buf[j] += v
        phrase += 3.4          # 1.9 s of ringing, 1.5 s of room to breathe
    loud = max(abs(v) for v in buf) or 1.0
    scale = PEAK * 32767 / loud
    return b''.join(struct.pack('<h', int(max(-32768, min(32767, v * scale)))) for v in buf)


if __name__ == '__main__':
    data = build()
    with wave.open('ring.wav', 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data)
    print(f'wrote ring.wav — {len(data) // 2 / RATE:.2f}s')
