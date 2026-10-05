# THREADBONER
## Starting Life Beyond the Covenant Door
### スレッドボナー：契約の扉の彼方で始まる生

*An original dark fantasy light novel by **BiniFn***

---

> **⚠️ COPYRIGHT NOTICE — ALL RIGHTS RESERVED**
>
> Copyright © 2024–2026 **BiniFn**. All Rights Reserved.
>
> This repository and all of its contents — including source code and the remaining original material associated with **"Threadboner: Starting Life Beyond the Covenant Door"** (スレッドボナー) — are the exclusive intellectual property of **BiniFn** and are protected under international copyright law.
>
> **You may NOT:** copy, reproduce, distribute, modify, plagiarize, use as AI training data, scrape, mirror, or create derivative works from any part of this repository without prior written permission from the author.
>
> **You MAY:** read the story at [threadborn.vercel.app](https://threadborn.vercel.app) for personal enjoyment.
>
> See [LICENSE](./LICENSE) and [COPYRIGHT](./COPYRIGHT) for full legal terms.
> Violations may result in DMCA takedowns and legal action.

---

## The Archive

Some records are missing by design. The public page offers a handful of fragments; their order matters more than their wording. The name on the cover is not the whole account.

The story remains sealed until its author decides the record is ready. For now, the door is visible, the key is not, and copyright remains with its author.

## Read the Archive

**[→ threadborn.vercel.app](https://threadborn.vercel.app)**

The entrance is available in English and Japanese. The manuscript archive is private and is not part of the deployed website.

## Credits

**BiniFn** — Author and rights holder of Threadboner and its associated original works.

| Channel | Link |
|---|---|
| Main | [@binifn](https://www.youtube.com/@binifn) |
| Roblox | [@binirbx](https://www.youtube.com/@binirbx) |
| Anime | [@binirx](https://www.youtube.com/@binirx) |
| GitHub | [BiniFn](https://github.com/BiniFn) |

---

## Private manuscript intake

The owner/admin upload screen is `/pdf-upload.html`. Connect a **private** Vercel Blob store to the Vercel project and make its `BLOB_READ_WRITE_TOKEN` and upload callback public key (`BLOB_WEBHOOK_PUBLIC_KEY`) available to the deployment. Set `DATABASE_URL` to the existing Postgres service and deploy the migration in `db/migrations/019_private_pdf_releases.sql` (the app applies it automatically on the next API request). The admin enters a title, volume number, and premiere time with each PDF. Uploads go directly from the browser to private Blob under `threadborn-archive/`; the database stores the schedule and path, not the PDF bytes. At premiere time the release appears on `/reader.html`, where the site issues a short-lived private read URL. The PDF is never committed to Git or included in a deployment.

## Self-hosted narration

The reader's `/api/reader/reactions?action=tts` endpoint can proxy to a model server that you control. Set `TTS_SERVICE_URL` to its HTTPS endpoint and optionally set `TTS_SERVICE_TOKEN` as a bearer credential. The service accepts `POST` JSON shaped like `{ "text": "...", "language": "en", "voice": "..." }` and responds with audio bytes using an `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/webm`, or `audio/mp4` content type. The existing reader route keeps its request rate limit and text length cap.

Run the model on a persistent machine or GPU inference host, then let the Vercel function proxy requests to it. Vercel and Netlify are suitable for the site and request proxy; their serverless functions are not persistent model hosts. Keep the model weights and inference process outside this repository. A Netlify migration would need an equivalent function endpoint and environment variables.

## Legal

This work is protected under international copyright law.
See [LICENSE](./LICENSE) and [COPYRIGHT](./COPYRIGHT) for full terms.

© 2024–2026 **BiniFn**. All Rights Reserved.
No part of this work may be reproduced without prior written permission from the author.
