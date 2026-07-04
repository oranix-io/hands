# Release runbook (draft-first flow)

Policy (artin, 2026-07-04): **CI never completes a real release.** CI builds,
signs, generates a raw changelog, and creates a **draft** release on Quiver.
A human or agent then reviews, writes the final bilingual changelog, and
publishes explicitly.

## 1. CI (automatic)

`botiverse/mobile` → Actions → **Android Release** (defaults to draft mode):

- builds + signs the APK
- generates a raw commit-subject changelog (previous build's
  `provenance.source_commit` → HEAD, fallback last 15 subjects)
- `quiver builds publish-android … --draft` creates the build + assets +
  **draft** release (invisible to update checks and share pages)
- job summary shows the draft release id and the raw changelog

## 2. Review + bilingual changelog (agent/human)

```sh
# inspect the draft
quiver releases show raft-android <releaseId>

# write the reviewed changelog in both languages
quiver releases update raft-android <releaseId> \
  --changelog-zh-file changelog.zh.md \
  --changelog-en-file changelog.en.md
```

Storage format: plain text (legacy, served as-is) or a JSON object
`{"en": "…", "zh-CN": "…"}`. Clients pick a language via `lang=` /
`X-Quiver-Lang` / `Accept-Language` on update checks; share pages use the
browser's `Accept-Language`. Fallback order: exact tag → language prefix →
`en` → first available.

## 3. Publish (explicit)

```sh
quiver releases publish raft-android <releaseId>
# then, if desired:
quiver releases share raft-android <releaseId> --password <pw>
```

Publishing supersedes the previous active release on the same
app/channel/product/release-type; staged rollout percentage can be set before
or after publish (`rollout_cohort_count`, bump via admin or API).
