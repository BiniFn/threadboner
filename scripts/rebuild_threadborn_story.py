import html
import json
import re
import sys
import time
from pathlib import Path

from deep_translator import GoogleTranslator


ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path("/Users/amela/Documents/New project/Threadborn Expanded.md")
CACHE = Path("/tmp/threadborn_ja_translation_cache.json")

NEW_SLOGAN_EN = "Threadborn: Reborn With Zero Dignity"
NEW_SLOGAN_JA = "スレッドボーン：Reborn With Zero Dignity"
REPO_SLUG = "Threadborn-Starting-Life-Beyond-the-Covenant-Door"

TITLE_MAP_JA = {
    "Threadborn: Volume 1: Reborn With Zero Dignity": "スレッドボーン：第1巻：尊厳ゼロでの再生",
    "Threadborn: Volume 2: The Covenant Door": "スレッドボーン：第2巻：誓約の扉",
    NEW_SLOGAN_EN: NEW_SLOGAN_JA,
}

TERM_FIXES = {
    "風島与乃": "風嶋ヨノ",
    "風島夜乃": "風嶋ヨノ",
    "風島夜野": "風嶋ヨノ",
    "ヨノ風島": "風嶋ヨノ",
    "与野風島": "風嶋ヨノ",
    "風島ヨノ": "風嶋ヨノ",
    "風嶋世乃": "風嶋ヨノ",
    "ヨノさん": "ヨノ",
    "与野": "ヨノ",
    "世乃": "ヨノ",
    "夜乃": "ヨノ",
    "夜野": "ヨノ",
    "ユノ": "ヨノ",
    "ヴァイオレット": "バイオレット",
    "メリカ": "メリン",
    "カエル": "ケイル",
    "ケール": "ケイル",
    "ヴェルコール": "ヴェルコール",
    "ルメーラ": "ルメラ",
    "スレッドボーン": "スレッドボーン",
}


def normalize_story_text(text: str) -> str:
    text = text.replace("*Threadborn: Starting Life Where Fate Breaks*", f"*{NEW_SLOGAN_EN}*")
    text = text.replace("\u202f", " ")
    text = text.replace("Chapter\u202f", "Chapter ")
    text = text.replace("Volume\u202f", "Volume ")
    text = re.sub(r"^---$", "***", text, flags=re.MULTILINE)
    text = re.sub(r"([A-Za-z0-9])[\u2010-\u2015-]([A-Za-z0-9])", r"\1 \2", text)
    text = re.sub(r"[\u2010-\u2015-]+", " ", text)
    text = re.sub(r"[ \t]+$", "", text, flags=re.MULTILINE)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip() + "\n"


def load_cache() -> dict:
    if CACHE.exists():
        return json.loads(CACHE.read_text(encoding="utf-8"))
    return {}


def save_cache(cache: dict) -> None:
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def split_translatable_line(line: str):
    if not line.strip() or line.strip() == "***":
        return None

    if line in TITLE_MAP_JA:
        return ("", line, "")

    m = re.match(r"^(#{1,6}\s+)(.+)$", line)
    if m:
        return (m.group(1), m.group(2), "")

    m = re.match(r"^(\*\s*)(Volume\s+\d+\s+·\s+Chapter\s+\d+)(\s*\*)$", line)
    if m:
        return (m.group(1), m.group(2), m.group(3))

    m = re.match(r"^(\*)(End of Chapter\s+\d+)(\*)$", line)
    if m:
        return (m.group(1), m.group(2), m.group(3))

    m = re.match(r"^(\*)(.+)(\*)$", line)
    if m:
        return (m.group(1), m.group(2), m.group(3))

    m = re.match(r"^(>\s*)(\d+\.\s+)?(.+)$", line)
    if m:
        return (m.group(1) + (m.group(2) or ""), m.group(3), "")

    return ("", line, "")


def restore_terms(text: str) -> str:
    for old, new in TERM_FIXES.items():
        text = text.replace(old, new)
    text = text.replace("Yono Kazeshima", "風嶋ヨノ")
    text = text.replace("Yono", "ヨノ")
    text = text.replace("Violet Arden", "バイオレット・アーデン")
    text = text.replace("Violet", "バイオレット")
    text = text.replace("Lumera", "ルメラ")
    text = text.replace("Liri", "リリ")
    text = text.replace("Meryn", "メリン")
    text = text.replace("Mirika Solenne", "ミリカ・ソレンヌ")
    text = text.replace("Mirika", "ミリカ")
    text = text.replace("Lyra", "ライラ")
    text = text.replace("Velkor", "ヴェルコール")
    text = text.replace("Cadreth", "カドレス")
    text = text.replace("Cael", "ケイル")
    text = text.replace("Sela", "セラ")
    text = text.replace("Tovin", "トヴィン")
    text = text.replace("Darin", "ダリン")
    text = text.replace("Asteria", "アステリア")
    text = text.replace("Threadborn", "スレッドボーン")
    text = text.replace("Covenant", "コヴナント")
    text = text.replace("Shade", "シェード")
    text = text.replace("Warden", "監視者")
    text = re.sub(r"[\u2010-\u2015-]+", " ", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text


def restore_repo_urls(text: str) -> str:
    text = text.replace("BiniFn/スレッドボーン Starting Life Beyond the コヴナント Door", f"BiniFn/{REPO_SLUG}")
    text = text.replace("BiniFn/スレッドボーン-Starting-Life-Beyond-the-コヴナント-Door", f"BiniFn/{REPO_SLUG}")
    return text


def translate_markdown_ja(source: str) -> str:
    translator = GoogleTranslator(source="en", target="ja")
    cache = load_cache()
    lines = source.splitlines()
    pieces = []
    missing = []

    for idx, line in enumerate(lines):
        parts = split_translatable_line(line)
        if not parts:
            pieces.append((line, None, None, None))
            continue
        prefix, body, suffix = parts
        if body in TITLE_MAP_JA:
            translated = TITLE_MAP_JA[body]
            pieces.append((None, prefix, translated, suffix))
            continue
        if body in cache:
            pieces.append((None, prefix, cache[body], suffix))
        else:
            pieces.append((None, prefix, body, suffix))
            missing.append(body)

    unique_missing = list(dict.fromkeys(missing))
    print(f"Translating {len(unique_missing)} uncached lines...", flush=True)

    for i, body in enumerate(unique_missing, start=1):
        for attempt in range(3):
            try:
                translated = translator.translate(body)
                cache[body] = restore_terms(translated) if translated else body
                break
            except Exception as exc:
                if attempt == 2:
                    raise RuntimeError(f"Failed translating line {i}: {body[:80]}") from exc
                time.sleep(1.5 + attempt)
        if i % 50 == 0:
            print(f"Translated {i}/{len(unique_missing)}", flush=True)
            save_cache(cache)

    save_cache(cache)

    out = []
    for original, prefix, body, suffix in pieces:
        if original is not None:
            out.append(original)
        else:
            out.append(prefix + restore_terms(cache.get(body, body)) + suffix)

    result = "\n".join(out)
    result = result.replace(f"*{NEW_SLOGAN_EN}*", f"*{NEW_SLOGAN_JA}*")
    result = re.sub(r"\*第\s*(\d+)\s*章の終わり\*", r"*第\1章 終わり*", result)
    result = re.sub(r"\*第\s*(\d+)\s*章 終了\*", r"*第\1章 終わり*", result)
    result = re.sub(r"[\u2010-\u2015-]+", " ", result)
    result = re.sub(r"[ \t]+$", "", result, flags=re.MULTILINE)
    return result.strip() + "\n"


def parse_chapters(md: str):
    lines = md.splitlines()
    chapters = []
    current_volume = None
    current_volume_title = None
    i = 0
    while i < len(lines):
        line = lines[i]
        vm = re.match(r"^#\s+(.+)$", line)
        if vm and ("Volume" in vm.group(1) or "巻" in vm.group(1)):
            current_volume_title = vm.group(1).strip()
            vol_match = re.search(r"Volume\s+(\d+)", current_volume_title)
            if not vol_match:
                vol_match = re.search(r"第\s*(\d+)\s*巻", current_volume_title)
            current_volume = int(vol_match.group(1)) if vol_match else len({c["volume_num"] for c in chapters}) + 1
            i += 1
            continue
        cm = re.match(r"^##\s+Chapter\s+(\d+):\s+(.+)$", line)
        if not cm:
            cm = re.match(r"^##\s+第\s*(\d+)\s*章[:：]?\s*(.+)$", line)
        if not cm:
            i += 1
            continue

        ch_num = int(cm.group(1))
        fallback_title = cm.group(2).strip()
        start = i
        i += 1
        section = []
        while i < len(lines):
            if (
                re.match(r"^##\s+Chapter\s+\d+:", lines[i])
                or re.match(r"^##\s+第\s*\d+\s*章", lines[i])
                or re.match(r"^#\s+.+Volume\s+\d+", lines[i])
                or re.match(r"^#\s+.+第\s*\d+\s*巻", lines[i])
            ):
                break
            section.append(lines[i])
            i += 1

        title = fallback_title
        subtitle = ""
        content_start = 0
        for idx, sline in enumerate(section):
            if re.match(r"^##\s+", sline) and "Chapter" not in sline:
                title = sline.replace("##", "", 1).strip()
                content_start = idx + 1
                break
        for idx in range(content_start, len(section)):
            sline = section[idx].strip()
            if sline.startswith("*Volume"):
                continue
            if sline.startswith("*") and sline.endswith("*") and "End of Chapter" not in sline:
                subtitle = sline.strip("*").strip()
                content_start = idx + 1
                break

        content = "\n".join(section[content_start:]).strip()
        chapters.append({
            "volume_num": current_volume or 1,
            "volume_title": current_volume_title or "",
            "chapter_num": ch_num,
            "chapter_heading": fallback_title,
            "title": title,
            "subtitle": subtitle,
            "content": content,
        })

    return chapters


def inline_md_to_html(text: str) -> str:
    escaped = html.escape(text)
    escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"\*(.+?)\*", r"<em>\1</em>", escaped)
    return escaped


def content_blocks(content: str):
    raw_blocks = re.split(r"\n\s*\n", content)
    return [b.strip() for b in raw_blocks if b.strip() and b.strip() != "***"]


def chapter_pages(chapter, jp=False):
    number_label = (
        f'第{chapter["volume_num"]:02d}巻 · 第{chapter["chapter_num"]:02d}章'
        if jp
        else f'Volume {chapter["volume_num"]:02d} · Chapter {chapter["chapter_num"]:02d}'
    )
    head = f'''<div class="chapter-head">
  <span class="chapter-num">{number_label}</span>
  <h2 class="chapter-title">{html.escape(chapter["title"])}</h2>
  <p class="chapter-subtitle">{inline_md_to_html(chapter["subtitle"])}</p>
</div>'''
    html_blocks = [head]
    for block in content_blocks(chapter["content"]):
        if block.startswith("##"):
            continue
        if block.startswith("*Volume"):
            continue
        if block.startswith("### "):
            html_blocks.append(f'<p class="scene-title">{inline_md_to_html(block[4:].strip())}</p>')
        elif block.startswith(">"):
            lines = [ln.strip()[1:].strip() if ln.strip().startswith(">") else ln.strip() for ln in block.splitlines()]
            title = lines[0] if lines else "Status"
            body = "<br>".join(inline_md_to_html(ln) for ln in lines[1:])
            html_blocks.append(f'<div class="system-box"><h5>{inline_md_to_html(title).replace("<em>", "").replace("</em>", "")}</h5><p>{body}</p></div>')
        elif re.match(r"^\*End of Chapter\s+\d+\*$", block):
            html_blocks.append(f'<div class="tbc">End of Chapter {chapter["chapter_num"]:02d}</div>')
        elif re.match(r"^\*第\d+章", block):
            html_blocks.append(f'<div class="tbc">{inline_md_to_html(block.strip("*"))}</div>')
        else:
            paragraph = inline_md_to_html(block).replace("\n", "<br>")
            html_blocks.append(f'<p class="novel-p">{paragraph}</p>')

    pages = []
    current = []
    p_count = 0
    for block in html_blocks:
        current.append(block)
        if 'class="novel-p"' in block:
            p_count += 1
        if p_count >= 12:
            pages.append("\n".join(current))
            current = []
            p_count = 0
    if current:
        pages.append("\n".join(current))
    return pages


def js_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def js_template(value: str) -> str:
    return "`" + value.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${") + "`"


def chapter_js_data(chapters, jp=False):
    legacy_items = []
    chapter_items = []
    for ch in chapters:
        pages = chapter_pages(ch, jp=jp)
        pages_js = "[\n" + ",\n".join("          " + js_template(p) for p in pages) + "\n        ]"
        if ch["volume_num"] == 1:
            legacy_label = (
                f'第{ch["chapter_num"]:02d}章 · {ch["title"]}'
                if jp
                else f'Chapter {ch["chapter_num"]:02d} · {ch["title"]}'
            )
            legacy_items.append(f'''  {{
    label: {js_string(legacy_label)},
    pages: {pages_js}
  }}''')
        page_ref = f"legacyEpisodes[{ch['chapter_num'] - 1}].pages" if ch["volume_num"] == 1 else pages_js
        volume_label = f"Volume {ch['volume_num']}" if not jp else f"第{ch['volume_num']}巻"
        chapter_label = f"Chapter {ch['chapter_num']}" if not jp else f"第{ch['chapter_num']}章"
        label = ch["chapter_heading"]
        item = f'''      {{
        volume: {js_string(volume_label)},
        chapter: {js_string(chapter_label)},
        label: {js_string(label)},
        title: {js_string(ch["title"])},
        summary: {js_string(ch["subtitle"])},
        tags: [{js_string("story")}],
        pages: {page_ref}
      }}'''
        chapter_items.append(item)
    return "    const legacyEpisodes = [\n" + ",\n".join(legacy_items) + "\n    ];\n\n    const chapters = [\n" + ",\n".join(chapter_items) + "\n    ];\n\n"


def replace_story_data(html_text: str, data_js: str) -> str:
    start = html_text.index("    const legacyEpisodes = [")
    end = html_text.index("    const characters = [")
    return html_text[:start] + data_js + html_text[end:]


def update_html_file(path: Path, md: str, jp=False):
    chapters = parse_chapters(md)
    template_path = ROOT / "index.html" if jp else path
    html_text = template_path.read_text(encoding="utf-8")
    html_text = replace_story_data(html_text, chapter_js_data(chapters, jp=jp))
    if jp:
        html_text = html_text.replace('<html lang="en">', '<html lang="ja">')
        html_text = html_text.replace("Threadborn — Starting Life Beyond the Covenant Door", NEW_SLOGAN_JA)
        html_text = html_text.replace("Threadborn – Starting Life Beyond the Covenant Door", NEW_SLOGAN_JA)
        html_text = html_text.replace("Threadborn: Starting Life Beyond the Covenant Door", NEW_SLOGAN_JA)
        html_text = html_text.replace("Threadborn: Reborn With Zero Dignity", NEW_SLOGAN_JA)
        html_text = restore_repo_urls(html_text)
        html_text = html_text.replace("threadborn-logo-en-header.png", "threadborn-logo-jp-header.png")
        html_text = html_text.replace("threadborn-logo-en-wide.png", "threadborn-logo-jp-wide.png")
        html_text = html_text.replace("threadborn-favicon.png", "threadborn-favicon-jp.png")
        html_text = html_text.replace("threadborn-apple-touch.png", "threadborn-logo-jp.png")
        html_text = html_text.replace("threadborn-og-en.png", "threadborn-og-jp.png")
        html_text = html_text.replace("threadborn-app-icon.png", "threadborn-logo-jp.png")
        html_text = html_text.replace("Anime / Light Novel • dark fantasy • romance • gore • cosmic horror", "アニメ / ライトノベル • ダークファンタジー • ロマンス • ゴア • コズミックホラー")
        html_text = html_text.replace('<h1 class="series-title">Threadborn</h1>', '<h1 class="series-title">スレッドボーン</h1>')
        html_text = html_text.replace("Fate isn't given. It's severed.", "運命は与えられない。断ち切るもの。")
        html_text = html_text.replace("<span>Reborn With Zero Dignity</span>", "<span>Reborn With Zero Dignity</span>")
        html_text = html_text.replace("Threadborn: Reborn With Zero Dignity • dark fantasy • romance • gore • cosmic horror", "スレッドボーン：Reborn With Zero Dignity • ダークファンタジー • ロマンス • ゴア • コズミックホラー")
        html_text = html_text.replace("A boy dies, wakes in Lumera, and steps into a world that was never meant to survive him.", "少年は死に、ルメラで目覚め、生き残るはずのない世界へ足を踏み入れる。")
        html_text = html_text.replace("<strong>Threadborn</strong> follows <strong>Yono Kazeshima</strong> after a sudden death throws him into Lumera beside Violet. Survival turns into dark fantasy, romance, and sealed monsters that get worse each chapter.", "<strong>Threadborn</strong> は、突然の死によってバイオレットと共にルメラへ放り込まれた<strong>風嶋ヨノ</strong>の物語。生き残るための戦いは、ダークファンタジー、ロマンス、そして章を追うごとに凶悪になる封印された怪物たちとの遭遇へ変わっていく。")
        html_text = html_text.replace("<strong>Volume 1:</strong> Yono learns Lumera’s rules, survives the Shade debt arc, and reaches the forest door hiding Velkor’s prison.", "<strong>第1巻:</strong> ヨノはルメラの法則を学び、シェードの借金編を生き延び、ヴェルコールの牢獄を隠す森の扉へたどり着く。")
        html_text = html_text.replace("🌐 Switch to Japanese", "🌐 Switch to English")
        html_text = html_text.replace(">🌐 EN</button>", ">🌐 日本語</button>")
        html_text = html_text.replace("localStorage.getItem('threadborn_lang') || 'en'", "localStorage.getItem('threadborn_lang') || 'ja'")
        html_text = html_text.replace("Volume 1", "第1巻")
        html_text = html_text.replace("Volume 2", "第2巻")
        html_text = html_text.replace("Read 第1巻", "第1巻を読む")
        html_text = html_text.replace("Read 第2巻", "第2巻を読む")
    else:
        html_text = html_text.replace("Threadborn — Starting Life Beyond the Covenant Door", NEW_SLOGAN_EN)
        html_text = html_text.replace("Threadborn – Starting Life Beyond the Covenant Door", NEW_SLOGAN_EN)
        html_text = html_text.replace("Threadborn: Starting Life Beyond the Covenant Door", NEW_SLOGAN_EN)
        html_text = html_text.replace("Threadborn: Reborn With Zero Dignity", NEW_SLOGAN_EN)
    path.write_text(html_text, encoding="utf-8")


def update_static_texts():
    readme = ROOT / "README.md"
    if readme.exists():
        s = readme.read_text(encoding="utf-8")
        s = s.replace("# Threadborn – Starting Life Beyond the Covenant Door", f"# {NEW_SLOGAN_EN}")
        s = s.replace("Threadborn — Starting Life Beyond the Covenant Door", NEW_SLOGAN_EN)
        s = s.replace("Threadborn – Starting Life Beyond the Covenant Door", NEW_SLOGAN_EN)
        s = s.replace("Threadborn: Starting Life Beyond the Covenant Door", NEW_SLOGAN_EN)
        readme.write_text(s, encoding="utf-8")

    manifest = ROOT / "manifest.json"
    if manifest.exists():
        data = json.loads(manifest.read_text(encoding="utf-8"))
        data["name"] = NEW_SLOGAN_EN
        data["short_name"] = "Threadborn"
        data["description"] = "Official reading hub for Threadborn. Read updated chapters, export collector PDFs, and download styled EPUBs fully offline."
        manifest.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    if not SOURCE.exists():
        print(f"Missing source file: {SOURCE}", file=sys.stderr)
        sys.exit(1)

    en_md = normalize_story_text(SOURCE.read_text(encoding="utf-8"))
    (ROOT / "Threadborn-Complete.md").write_text(en_md, encoding="utf-8")

    ja_md = translate_markdown_ja(en_md)
    (ROOT / "Threadborn-Complete-JP.md").write_text(ja_md, encoding="utf-8")

    update_html_file(ROOT / "index.html", en_md, jp=False)
    update_html_file(ROOT / "index-jp.html", ja_md, jp=True)
    update_static_texts()

    print("Updated English Markdown, Japanese Markdown, and reader HTML files.")


if __name__ == "__main__":
    main()
