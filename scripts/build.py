"""Build reveal.js slide decks into self-contained HTML and PDF."""

import base64
import json
import mimetypes
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse
from urllib.request import urlopen

REPO_ROOT = Path(__file__).resolve().parent.parent
DECKS_DIR = REPO_ROOT / "decks"
FORMATS = ["html", "pdf"]


def find_decks() -> list[Path]:
    """Find all index.html slide decks under decks/."""
    if not DECKS_DIR.exists():
        return []
    return sorted(DECKS_DIR.glob("*/index.html"))


def resolve_local_path(href: str, base_dir: Path) -> Path | None:
    """Resolve a relative href to a local file path."""
    parsed = urlparse(href)
    if parsed.scheme in ("http", "https", "data", ""):
        if parsed.scheme in ("http", "https"):
            return None
    if parsed.scheme == "data":
        return None
    resolved = (base_dir / unquote(href)).resolve()
    if resolved.exists():
        return resolved
    return None


def inline_css_file(css_path: Path, base_dir: Path, remote_cache: dict[str, str]) -> str:
    """Read a CSS file and inline any url() references."""
    css = css_path.read_text(encoding="utf-8")
    css_dir = css_path.parent

    def replace_url(m):
        url = m.group(1).strip("'\"")
        if url.startswith("data:"):
            return m.group(0)
        if url.startswith("http"):
            data_url = remote_cache.get(url)
            if data_url is None:
                try:
                    with urlopen(url) as response:
                        payload = response.read()
                        mime = response.headers.get_content_type()
                except Exception as exc:
                    print(f"  WARN: failed to inline {url}: {exc}")
                    return m.group(0)
                if mime == "application/octet-stream":
                    mime = mimetypes.guess_type(urlparse(url).path)[0] or mime
                data = base64.b64encode(payload).decode()
                data_url = f'data:{mime};base64,{data}'
                remote_cache[url] = data_url
            return f'url("{data_url}")'
        local = resolve_local_path(url, css_dir)
        if local and local.exists():
            mime = mimetypes.guess_type(str(local))[0] or "application/octet-stream"
            data = base64.b64encode(local.read_bytes()).decode()
            return f'url("data:{mime};base64,{data}")'
        return m.group(0)

    css = re.sub(r"url\(([^)]+)\)", replace_url, css)
    return css


def build_self_contained_html(deck_path: Path, output_path: Path):
    """Bundle a reveal.js deck into a single self-contained HTML file."""
    html = deck_path.read_text(encoding="utf-8")
    base_dir = deck_path.parent
    remote_cache: dict[str, str] = {}
    inline_images: dict[str, str] = {}
    image_keys: dict[Path, str] = {}

    # Inline <link rel="stylesheet" href="...">
    def replace_link(m):
        href = m.group(1)
        local = resolve_local_path(href, base_dir)
        if local:
            css = inline_css_file(local, base_dir, remote_cache)
            return f"<style>\n{css}\n</style>"
        return m.group(0)

    html = re.sub(
        r'<link\s+rel="stylesheet"\s+href="([^"]+)"[^>]*>',
        replace_link,
        html,
    )

    # Inline <script src="...">
    def replace_script(m):
        src = m.group(1)
        local = resolve_local_path(src, base_dir)
        if local:
            js = local.read_text(encoding="utf-8")
            return f"<script>\n{js}\n</script>"
        return m.group(0)

    html = re.sub(
        r'<script\s+src="([^"]+)"[^>]*></script>',
        replace_script,
        html,
    )

    # Inline <img src="..."> as base64
    def replace_img(m):
        full = m.group(0)
        src = m.group(1)
        local = resolve_local_path(src, base_dir)
        if local:
            key = image_keys.get(local)
            if key is None:
                key = f"img_{len(image_keys)}"
                image_keys[local] = key
                mime = mimetypes.guess_type(str(local))[0] or "image/png"
                if local.suffix == ".svg":
                    mime = "image/svg+xml"
                data = base64.b64encode(local.read_bytes()).decode()
                inline_images[key] = f"data:{mime};base64,{data}"
            return full.replace(f'src="{src}"', f'data-inline-image="{key}"')
        return full

    html = re.sub(r'<img\s[^>]*src="([^"]+)"[^>]*>', replace_img, html)

    if inline_images:
        image_loader = (
            "<script>\n"
            f"const INLINE_IMAGES = {json.dumps(inline_images, separators=(',', ':'))};\n"
            "document.querySelectorAll('img[data-inline-image]').forEach((img) => {\n"
            "  const key = img.getAttribute('data-inline-image');\n"
            "  if (INLINE_IMAGES[key]) {\n"
            "    img.src = INLINE_IMAGES[key];\n"
            "  }\n"
            "  img.removeAttribute('data-inline-image');\n"
            "});\n"
            "</script>"
        )
        html = html.replace("</body>", f"{image_loader}\n</body>")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html, encoding="utf-8")
    print(f"  OK: {output_path.relative_to(REPO_ROOT)}")


def build_pdf(deck_html: Path, output_path: Path):
    """Export slides to PDF using decktape."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    npx = "npx"
    cmd = [
        npx,
        "decktape",
        "reveal",
        f"file://{deck_html.resolve()}",
        str(output_path),
        "--size",
        "792x612",
    ]
    print(f"  Building PDF via decktape ...")
    result = subprocess.run(cmd, cwd=REPO_ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  PDF ERROR: {result.stderr.strip()}")
        if "puppeteer" in result.stderr.lower() or "chrome" in result.stderr.lower():
            print(
                "  Hint: PDF export requires Chrome/Chromium. Install with: npx puppeteer browsers install chrome"
            )
    else:
        print(f"  OK: {output_path.relative_to(REPO_ROOT)}")


def build_deck(deck_path: Path, formats: list[str] | None = None):
    """Build a single deck into requested formats."""
    dist_dir = deck_path.parent / "dist"

    for fmt in formats or FORMATS:
        if fmt == "html":
            output = dist_dir / "slides.html"
            build_self_contained_html(deck_path, output)
        elif fmt == "pdf":
            html_out = dist_dir / "slides.html"
            if not html_out.exists():
                build_self_contained_html(deck_path, html_out)
            output = dist_dir / "slides.pdf"
            build_pdf(html_out, output)


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else None
    formats = None
    if "--format" in sys.argv:
        idx = sys.argv.index("--format")
        formats = sys.argv[idx + 1].split(",")

    if target:
        deck_path = DECKS_DIR / target / "index.html"
        if not deck_path.exists():
            print(f"Deck not found: {deck_path}")
            sys.exit(1)
        print(f"Building deck: {target}")
        build_deck(deck_path, formats)
    else:
        decks = find_decks()
        if not decks:
            print("No decks found in decks/")
            sys.exit(0)
        print(f"Found {len(decks)} deck(s)")
        for deck_path in decks:
            deck_name = deck_path.parent.name
            print(f"\nBuilding deck: {deck_name}")
            build_deck(deck_path, formats)

    print("\nDone.")


if __name__ == "__main__":
    main()
