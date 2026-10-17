# Changelog

All notable changes to **AudioBlock Backend** are documented here.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) conventions.  
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Automation note:** From v1.1.0 onwards, draft entries are generated automatically
> by [release-drafter](https://github.com/release-drafter/release-drafter) from merged
> PR titles and labels. A maintainer reviews and publishes the draft via the
> GitHub Releases UI before each release. See [RELEASING.md](./RELEASING.md) for the
> full process.

> **AI feature convention (#298):** Entries that introduce or modify AI-assisted
> features (cover art generation, description generation, lyric transcription,
> translation, etc.) must be tagged with  at the start of the bullet,
> e.g. . This helps end users
> identify which features involve AI at a glance. Apply the tag consistently
> going forward and retroactively to any AI-related entries once shipped.

---

## [Unreleased]

### Added
- Automated changelog drafting via release-drafter
- `RELEASING.md` — documented versioning and release process
- `docs/branch-protection.md` — live branch protection rules
- `.github/CODEOWNERS` — automatic reviewer assignment per codebase area
- `CONTRIBUTING.md` — contribution guide covering changelog, releases, and reviews

---

## [1.0.0] - 2024-01-01

### Added
- Initial release of AudioBlock Backend
- Artist, Song, Album, and Marketplace on-chain integration (Soroban / Stellar)
- JWT authentication with Dynamic Labs wallet support
- Chunked audio upload pipeline with S3 and FFmpeg processing
- RabbitMQ-backed job queue for async song processing
- Redis caching layer
- TypeORM PostgreSQL data layer with migrations
- Royalty reconciliation job
- Pinata IPFS integration for metadata

[Unreleased]: https://github.com/Darkvader-ship-it/AudioBlock_Backend/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Darkvader-ship-it/AudioBlock_Backend/releases/tag/v1.0.0
