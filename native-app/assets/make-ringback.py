#!/usr/bin/env python3
"""Generates assets/ringback.wav — what the CALLER hears while waiting.

Reported as: the call ringtone plays on the caller's device instead of the
receiver's. Both ends were playing ring.wav, which is a RINGTONE: loud, bright,
written to be heard from across a room through a pocket. That is the right
sound for the phone being called and the wrong one for the phone doing the
calling, where it drowns out the moment the other person picks up.

A ringback is the other half of the pair and a different thing entirely: the
quiet purring tone the network plays down the line to say "it is ringing at the
other end". The classic is two sine tones together — 440 Hz and 480 Hz — two
seconds on, four seconds off, at a fraction of the volume.

Deliberately dull: nobody should ever notice this sound, only its absence when
the call connects.

Run: python3 native-app/assets/make-ringback.py
"""
import math
import struct
import wave

SR = 22050   # a 440/480 Hz pair needs nothing more, and this is a third of the size
ON = 2.0     # seconds of tone
OFF = 4.0    # seconds of silence — the pause is what makes it a ring
# ONE cycle. Both clients loop this file, so writing five of them would be
# five times the download for the same six seconds of sound — and most of a
# ringback is silence, which compresses to nothing but ships as bytes.
CYCLES = 1

buf = []
for _ in range(CYCLES):
    n = int(ON * SR)
    for i in range(n):
        t = i / SR
        # A 15 ms fade at each end of the burst: a sine cut mid-cycle clicks,
        # and a click is the one thing that WOULD be noticed.
        fade = min(1.0, i / (0.015 * SR), (n - i) / (0.015 * SR))
        v = math.sin(2 * math.pi * 440 * t) + math.sin(2 * math.pi * 480 * t)
        buf.append(0.5 * fade * v / 2)
    buf.extend([0.0] * int(OFF * SR))

peak = max(abs(v) for v in buf) or 1.0
# Quiet on purpose: this plays at the earpiece, an inch from an ear, under
# somebody's attention rather than for it.
scale = 0.35 / peak
frames = b''.join(struct.pack('<h', int(max(-1.0, min(1.0, v * scale)) * 32767)) for v in buf)

with wave.open('native-app/assets/ringback.wav', 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(frames)
print(f'ringback.wav: {len(buf) / SR:.1f}s, {len(frames) / 1024:.0f} KiB')
