#!/usr/bin/env python3
"""Render docs/assets/ecosystem.png: e3d-brain at the centre, a thread to each system that gets a memory.

Procedural (numpy + Pillow); reuses the spinning-brain renderer. No network, no paid services.
  python3 docs/assets/render_ecosystem.py [out.png]
"""
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import ecosystem            # noqa: E402
import render_brain as bm   # noqa: E402

out = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).parent / 'ecosystem.png')
bm.W, bm.H = 1280, 720
pts, edges = bm.build()
phase = bm.rng.uniform(0, 2 * math.pi, len(pts))
phase = 0.5 * phase + 3.0 * (pts[:, 2] + pts[:, 1])


def loader():
    f = bm.frame(pts, edges, phase, 0.13, 0.28)
    arr = np.clip(np.asarray(f, float) * 1.3 - 10, 0, 255) * ecosystem.brain_mask()[:, :, None]
    im = Image.fromarray(arr.astype('uint8'))
    return im.resize((int(im.width * 500 / im.height), 500), Image.LANCZOS)


ecosystem.static_png(out, loader,
                     caption='Planned integrations. Each system keeps its own brain on its own vault. '
                             'Memory advises, and never decides.')
print(out)
