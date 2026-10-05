import re, html as htmlmod

src = open("index.html", encoding="utf-8").read()

# ── helpers ────────────────────────────────────────────────────────────────
def strip_html(s):
    s = htmlmod.unescape(s)
    s = re.sub(r'<br\s*/?>', '\n', s)
    s = re.sub(r'<div class="scene-break">[^<]*</div>', '\n\n---\n\n', s)
    s = re.sub(r'<p class="scene-title">(.*?)</p>',   r'\n### \1\n',  s, flags=re.DOTALL)
    s = re.sub(r'<h2 class="chapter-title">(.*?)</h2>',r'\n## \1\n',  s, flags=re.DOTALL)
    s = re.sub(r'<span class="chapter-num">(.*?)</span>',r'*\1*\n',   s, flags=re.DOTALL)
    s = re.sub(r'<p class="chapter-subtitle">(.*?)</p>',r'*\1*\n',    s, flags=re.DOTALL)
    s = re.sub(r'<span class="(?:dialogue|thought|shout|emphasis)">(.*?)</span>',r'\1',s,flags=re.DOTALL)
    s = re.sub(r'<em>(.*?)</em>',     r'*\1*',  s, flags=re.DOTALL)
    s = re.sub(r'<strong>(.*?)</strong>',r'**\1**',s,flags=re.DOTALL)
    s = re.sub(r'<span class="big-sfx">(.*?)</span>',r'\n\n**\1**\n\n',s,flags=re.DOTALL)
    def fmt_sysbox(m):
        body = re.sub(r'<[^>]+>', '', m.group(2)).replace('\n', '\n> ')
        return f'\n\n> **{m.group(1)}**\n> {body.strip()}\n\n'
    s = re.sub(r'<div class="system-box">\s*<h5>(.*?)</h5>(.*?)</div>', fmt_sysbox, s, flags=re.DOTALL)
    s = re.sub(r'<div class="ep-intro-bar">.*?</div>','',s,flags=re.DOTALL)
    s = re.sub(r'<div class="tbc">(.*?)</div>',
               lambda m: '\n\n---\n\n*' + re.sub(r'<[^>]+>','',m.group(1)) + '*\n', s, flags=re.DOTALL)
    s = re.sub(r'<div class="fanservice-note">(.*?)</div>',
               lambda m: '\n\n*' + m.group(1).strip() + '*\n\n', s, flags=re.DOTALL)
    s = re.sub(r'<p[^>]*>(.*?)</p>', r'\1\n\n', s, flags=re.DOTALL)
    s = re.sub(r'<div[^>]*>', '', s); s = re.sub(r'</div>', '', s)
    s = re.sub(r'<[^>]+>', '', s)
    s = re.sub(r'\n{4,}', '\n\n\n', s)
    return s.strip()

def extract_template_literals(js_block):
    """Extract all top-level template literal strings (between backticks) in order."""
    results = []
    i = 0
    while i < len(js_block):
        if js_block[i] == '`':
            j = i + 1
            while j < len(js_block):
                if js_block[j] == '\\':
                    j += 2          # skip escaped char
                elif js_block[j] == '`':
                    results.append(js_block[i+1:j])
                    i = j + 1
                    break
                else:
                    j += 1
            else:
                break
        else:
            i += 1
    return results

def get_pages_block(js_text, start_hint=0):
    """Find the first pages: [ ... ] after start_hint and return its contents."""
    m = re.search(r'pages:\s*\[', js_text[start_hint:])
    if not m:
        return []
    abs_start = start_hint + m.end()
    depth = 1
    i = abs_start
    while i < len(js_text) and depth:
        if js_text[i] == '[':   depth += 1
        elif js_text[i] == ']': depth -= 1
        i += 1
    inner = js_text[abs_start:i-1]
    return extract_template_literals(inner)

# ── locate JS sections ─────────────────────────────────────────────────────
legacy_js = ""
chapters_js = ""

# ── Volume 1 — legacy episode extraction from content files ──────────────
chapter_blocks_v1 = re.split(r'// ---- CHAPTER \d+ ----', legacy_js)
chapter_blocks_v1 = [b for b in chapter_blocks_v1 if 'pages:' in b]

# ── Optional legacy extraction ────────────────────────────────────────────
ch5_match = re.search(r'legacyEpisodes\.push\(\{([\s\S]*?)\}\);', legacy_js, re.DOTALL)

legacy_pages = []
for block in chapter_blocks_v1:
    pages = get_pages_block(block)
    legacy_pages.append(pages)

if ch5_match:
    ch5_pages = get_pages_block('{' + ch5_match.group(1) + '}')
    legacy_pages.append(ch5_pages)

# ── Volume 2 — from chapters array ────────────────────────────────────────
# Find each volume 2 chapter entry
vol2_pages_all = []
cursor = 0
for m in re.finditer(r'volume:\s*"Volume 2"', chapters_js):
    pages = get_pages_block(chapters_js, m.start())
    if pages:
        vol2_pages_all.append(pages)

# ── meta ──────────────────────────────────────────────────────────────────
vol1_meta = [
    ("Chapter 1", "The first recovered record"),
    ("Chapter 2", "The second recovered record"),
    ("Chapter 3", "The third recovered record"),
    ("Chapter 4", "The fourth recovered record"),
    ("Chapter 5", "The fifth recovered record"),
]
vol2_meta = [
    ("Chapter 1", "A sealed record"),
    ("Chapter 2", "Another sealed record"),
]

# ── assemble MD ───────────────────────────────────────────────────────────
def build_md(all_pages, meta, vol_title, vol_sub):
    lines = [f"# Threadborn: {vol_title}", f"*{vol_sub}*", "", "***", ""]
    for i, pages in enumerate(all_pages):
        ch_num, ch_title = meta[i] if i < len(meta) else (f"Chapter {i+1}", "")
        lines.append(f"## {ch_num}: {ch_title}")
        lines.append("")
        for j, page in enumerate(pages):
            lines.append(strip_html(page))
            lines.append("")
            if j < len(pages) - 1:
                lines.append("*** page break ***")
                lines.append("")
        lines.append("")
        lines.append("---")
        lines.append("")
    return "\n".join(lines)

# ── print stats ───────────────────────────────────────────────────────────
print(f"Volume 1 chapters: {len(legacy_pages)}")
for i, p in enumerate(legacy_pages):
    print(f"  Ch{i+1}: {len(p)} pages")

print(f"Volume 2 chapters: {len(vol2_pages_all)}")
for i, p in enumerate(vol2_pages_all):
    print(f"  Ch{i+1}: {len(p)} pages")

# ── write files ───────────────────────────────────────────────────────────
v1 = build_md(legacy_pages, vol1_meta, "Volume 1 — Reborn With Zero Dignity", "Complete · 5 Chapters")
with open("Volume-1-Reborn-With-Zero-Dignity.md", "w", encoding="utf-8") as f:
    f.write(v1)
print(f"\nVolume-1-Reborn-With-Zero-Dignity.md written — {len(v1):,} chars")

v2 = build_md(vol2_pages_all, vol2_meta, "Volume 2 — The Covenant Door", "Active · 2 Chapters")
with open("Volume-2-The-Covenant-Door.md", "w", encoding="utf-8") as f:
    f.write(v2)
print(f"Volume-2-The-Covenant-Door.md written — {len(v2):,} chars")
