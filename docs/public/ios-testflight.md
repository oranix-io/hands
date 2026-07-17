# iOS releases & TestFlight

How a Raft iOS build travels from CI to TestFlight. The key fact: **Hands
uploads to Apple server-side** — the App Store Connect credential lives
encrypted in Hands, and the `.p8` key never leaves it. CI does not need Apple
upload credentials, and nobody runs `altool`.

## The flow

```
iOS Release workflow          Hands                          Apple
────────────────────          ─────                          ─────
build + sign IPA  ──────────▶ build + assets in R2
                              (publish_hands=true)
                              testflight-upload  ───────────▶ Build Upload API
                              (streams IPA from R2)           PROCESSING → COMPLETE
```

1. **Build + sign + publish** — dispatch the `iOS Release` workflow
   (botiverse/mobile) with `publish_hands=true`. It builds, signs with the
   distribution certificate, and uploads the IPA + dSYM to Hands as a build
   (usually with a draft release).
2. **Upload to TestFlight** — trigger the server-side upload for that build:

   ```
   POST /api/apps/{app_id}/builds/{build_id}/testflight-upload
   ```

   Hands streams the IPA from R2 straight to Apple's Build Upload API
   (create → register file → part PUTs → commit) and returns the initial
   state. Console: the build row's TestFlight action.
3. **Poll processing** —

   ```
   GET /api/apps/{app_id}/testflight-uploads/{build_upload_id}
   ```

   States: `AWAITING_UPLOAD → PROCESSING → COMPLETE | FAILED`. On COMPLETE
   the build appears in App Store Connect → TestFlight.

## One-time setup (app admin)

Store the App Store Connect API credential in Hands: console → App →
Settings → TestFlight (`PUT /api/apps/{app_id}/asc-credentials`). Generate the
key in App Store Connect → Users and Access → Integrations (App Manager role);
you need the Key ID, Issuer ID, and the `.p8` file. The credential is
encrypted at rest and can be verified without exposing it
(`POST .../asc-credentials/verify`). The same credential powers the
App Store review-state surface (`GET /api/apps/{app_id}/appstore-review`).

## Versioning rules

- The **marketing version** (e.g. `1.0.0`) may repeat across uploads.
- The **build number** (`versionCode`, e.g. `1000004`) must be unique and
  ascending for that marketing version — Apple rejects reused build numbers.
  Hands build history is the quick way to see the last used code.

## What CI must NOT do

- No `ASC_API_KEY_*` secrets in GitHub, no `xcrun altool` in workflows: the
  upload path is Hands. Duplicating the credential into CI widens the key
  surface and splits rotation.
- Cross-job artifact downloads on Blacksmith macOS runners fail
  (`ECONNREFUSED`); the design above avoids moving the IPA between jobs at
  all — Hands already has it.
