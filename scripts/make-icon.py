"""Pi Pen 앱 아이콘 생성: 어두운 라운드 사각형 배경 + π 기호가 새겨진 연필.

    python scripts/make-icon.py

build/icon.png (512px) 와 build/icon.ico (16~256 멀티사이즈) 를 만든다.
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), '..', 'build')
S = 1024          # 최종 크기
SS = 4            # 수퍼샘플링 배율 (안티앨리어싱)
N = S * SS

BG_TOP = (36, 44, 66)
BG_BOTTOM = (18, 21, 30)
ACCENT = (58, 120, 255)
BARREL = (247, 249, 252)
BARREL_EDGE = (206, 214, 228)
WOOD = (240, 196, 128)
GRAPHITE = (38, 42, 52)
FERRULE = (58, 120, 255)
ERASER = (255, 122, 112)
PI_COLOR = (32, 42, 62)

FONT_CANDIDATES = [
    r'C:\Windows\Fonts\arialbd.ttf',
    r'C:\Windows\Fonts\segoeuib.ttf',
    r'C:\Windows\Fonts\seguisym.ttf',
]


def pick_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def background():
    """세로 그라데이션 + 라운드 마스크."""
    grad = Image.new('RGB', (1, N))
    for y in range(N):
        t = y / (N - 1)
        grad.putpixel((0, y), tuple(
            round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)))
    bg = grad.resize((N, N))

    mask = Image.new('L', (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, N - 1, N - 1], radius=int(N * 0.22), fill=255)

    out = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    out.paste(bg, (0, 0), mask)

    # 안쪽 테두리 하이라이트 (얇은 링)
    ring = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    ImageDraw.Draw(ring).rounded_rectangle(
        [0, 0, N - 1, N - 1], radius=int(N * 0.22),
        outline=(255, 255, 255, 26), width=int(N * 0.008))
    out.alpha_composite(ring)
    return out


def pencil():
    """세로로 세운 연필을 그린 뒤 회전해서 돌려준다."""
    L = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(L)

    def px(v):
        return v * N

    left, right = px(0.355), px(0.645)
    mid = px(0.5)

    # 심 + 나무 촉
    d.polygon([(mid, px(0.115)), (left, px(0.315)), (right, px(0.315))], fill=WOOD)
    d.polygon([(mid, px(0.115)), (px(0.437), px(0.222)), (px(0.563), px(0.222))], fill=GRAPHITE)

    # 몸통
    d.rectangle([left, px(0.315), right, px(0.775)], fill=BARREL)
    d.line([(left, px(0.315)), (left, px(0.775))], fill=BARREL_EDGE, width=int(px(0.006)))
    d.line([(right, px(0.315)), (right, px(0.775))], fill=BARREL_EDGE, width=int(px(0.006)))

    # 금속 밴드
    d.rectangle([left, px(0.775), right, px(0.845)], fill=FERRULE)
    d.rectangle([left, px(0.800), right, px(0.815)], fill=(255, 255, 255, 60))

    # 지우개
    d.rounded_rectangle([left, px(0.845), right, px(0.935)],
                        radius=int(px(0.035)), fill=ERASER)

    # π 기호 (몸통 중앙)
    f = pick_font(int(px(0.30)))
    box = d.textbbox((0, 0), 'π', font=f)
    d.text((mid - (box[0] + box[2]) / 2, px(0.545) - (box[1] + box[3]) / 2),
           'π', font=f, fill=PI_COLOR)

    return L.rotate(-38, resample=Image.BICUBIC, center=(N / 2, N / 2))


def main():
    os.makedirs(OUT, exist_ok=True)
    img = background()
    img.alpha_composite(pencil())
    img = img.resize((S, S), Image.LANCZOS)

    png = os.path.join(OUT, 'icon.png')
    img.resize((512, 512), Image.LANCZOS).save(png)
    img.save(os.path.join(OUT, 'icon.ico'),
             sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print('생성 완료:', png, '및 icon.ico')


if __name__ == '__main__':
    main()
