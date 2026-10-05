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

## Admin setup and private manuscript intake

The site has two separate admin settings: the owner account is stored in Postgres, and the PDF files live in a **private** Vercel Blob store. The existing `threadborn-blob` store is public and supports public site media; keep it for that purpose. Do not put manuscript PDFs in it.

### 1. Configure Vercel

In the Vercel project settings, add these environment variables for the environments where the site will run (normally Production and Preview):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Connection string for the Postgres database. |
| `SESSION_SECRET` | Long, random value used to protect login sessions. |
| `OWNER_EMAIL` | Email address for the initial owner account. |
| `OWNER_PASSWORD` | Strong password for the initial owner account. |
| `PRIVATE_BLOB_READ_WRITE_TOKEN` | Credential for the separate private PDF Blob store. Mark it **Secret**. |
| `PRIVATE_BLOB_WEBHOOK_PUBLIC_KEY` | Public callback verification key supplied for that private store. |

Keep `BLOB_READ_WRITE_TOKEN` connected to the current public media store; the avatar and banner features still use it. Never paste a token into Git, a source file, a support request, or a public issue. `.env.example` lists the names without real credentials.

Create the PDF store in Vercel **Storage** as a new Blob store and choose **Private** access at creation. Link it to this project and configure its generated variable prefix so the token and callback key use the exact names `PRIVATE_BLOB_READ_WRITE_TOKEN` and `PRIVATE_BLOB_WEBHOOK_PUBLIC_KEY`. Vercel does not let you change a store from public to private later, so keep the existing public store intact. Set the token's visibility to **Secret** where Vercel offers that option. If the integration does not let you choose Secret visibility for a linked credential, use the Vercel storage connection/credential settings to issue a secret-scoped credential and make it available under the expected variable name.

The `BLOB_READ_WRITE_TOKEN` shown in the supplied Vercel screenshot belonged to the existing public store. Its credentials have been rotated, and a redeployment was requested. Vercel continued to show **Config / Needs Attention** after the rotation, so the warning is not confirmed resolved. In Vercel, open that variable or the store's project connection and change its visibility to **Secret** (or upgrade the connection to Vercel's supported OIDC flow if available). Check that the public media features continue to work after any credential change; do not delete the linked variable as a way to clear the warning.

After saving environment changes, redeploy the project so the functions receive them. For local development, copy `.env.example` to `.env.local`, fill in local credentials, and run `npm run dev`.

### 2. Set up the first owner

Make sure `OWNER_EMAIL` and `OWNER_PASSWORD` are set before the first owner login. Open `/login.html` (or `/login-jp.html`) and sign in with exactly that email and password. On the first login, the app creates the owner account if no owner exists. Later logins use the saved account password; changing the Vercel `OWNER_PASSWORD` does not reset an existing account. If that email is already registered as a non-owner account, choose an unused email or promote the account in the database before trying again. Admin access is limited to owner/admin roles.

The app automatically applies `db/migrations/019_private_pdf_releases.sql` on its first API request after deployment; there is no manual SQL paste step for a normally configured database. `DATABASE_URL` must allow the app to create/update its schema.

### 3. Upload and schedule a volume

While signed in as owner/admin, open `/pdf-upload.html`. Choose a PDF, enter its title and volume number, and select the premiere date and time. The date/time is interpreted in the browser's local time zone. Submit the upload; the browser sends the PDF directly to private Blob storage. The database keeps the title, volume, schedule, and storage path, not the PDF contents.

The volume appears in `/reader.html` when its premiere time arrives. Readers receive a short-lived signed link to the private PDF after release. PDFs are not committed to Git and are not bundled into the site deployment. Do not delete the private store or its token while releases still reference it.

### 4. Reveal the author bio later

The homepage currently shows `Author record: sealed.` To reveal it, edit the `#author-bio` text in `index.html` when ready, then commit and deploy that change. The old puzzle and all five marks have been removed.

## Self-hosted narration

The reader's `/api/reader/reactions?action=tts` endpoint can proxy to a model server that you control. Set `TTS_SERVICE_URL` to its HTTPS endpoint and optionally set `TTS_SERVICE_TOKEN` as a bearer credential. The service accepts `POST` JSON shaped like `{ "text": "...", "language": "en", "voice": "..." }` and responds with audio bytes using an `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/webm`, or `audio/mp4` content type. The existing reader route keeps its request rate limit and text length cap.

Run the model on a persistent machine or GPU inference host, then let the Vercel function proxy requests to it. Vercel and Netlify are suitable for the site and request proxy; their serverless functions are not persistent model hosts. Keep the model weights and inference process outside this repository. A Netlify migration would need an equivalent function endpoint and environment variables.

## Legal

This work is protected under international copyright law.
See [LICENSE](./LICENSE) and [COPYRIGHT](./COPYRIGHT) for full terms.

© 2024–2026 **BiniFn**. All Rights Reserved.
No part of this work may be reproduced without prior written permission from the author.
