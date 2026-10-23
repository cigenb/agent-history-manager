"""Generates build/icon.png and build/icon.ico.

Run: uv run --with pillow python scripts/make-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

S = 1024
out = Path(__file__).resolve().parent.parent / "build"
out.mkdir(exist_ok=True)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((64, 64, S - 64, S - 64), radius=210, fill=(217, 119, 87, 255))

# Speech bubble with a tail at the lower left
cream = (250, 249, 245, 255)
d.rounded_rectangle((232, 262, 792, 682), radius=120, fill=cream)
d.polygon([(330, 640), (300, 800), (470, 668)], fill=cream)

# Two text lines inside the bubble
line = (217, 119, 87, 255)
d.rounded_rectangle((342, 392, 682, 436), radius=22, fill=line)
d.rounded_rectangle((342, 506, 582, 550), radius=22, fill=line)

img.resize((512, 512), Image.Resampling.LANCZOS).save(out / "icon.png")
img.save(out / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", out / "icon.png", out / "icon.ico")
