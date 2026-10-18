# AudioBlock Backend Architecture Guide

This document provides a high-level architectural overview of the `AudioBlock_Backend` microservices and monolithic API layers, detailing system components, module responsibilities, feature code flows, and links to Architecture Decision Records (ADRs).

---

## High-Level Architecture Diagram

```mermaid
graph TD
    Client[Client App / Artist Dashboard / Web3 Wallet] -->|HTTP / REST API| Express[Express HTTP Server app.ts]

    subgraph Express Application Layer
        Express --> MW[Middlewares: Auth, Rate Limit, Validate DTO, Malware Scan]
        MW --> Controllers[Controllers: Auth, Song, Release, Royalty, Wallet]
    end

    subgraph Service & Core Logic Layer
        Controllers --> Container[DI Container / ServiceRegistry container.ts]
        Container --> Services[Services: AuthService, SongService, SorobanService, ScanService, MarketplaceService]
        Services --> Workers[Background Job Queue & Workers: Transcoding, Malware, Payout]
    end

    subgraph Data & Storage Layer
        Services --> TypeORM[TypeORM Repositories]
        TypeORM --> Postgres[(PostgreSQL Database)]
        Services --> Redis[(Redis Cache / Rate Limiting / Session)]
        Services --> S3[AWS S3 Bucket: Master Audio & Cover Art]
        Services --> IPFS[IPFS / Pinata: Audio & Metadata CIDs]
    end

    subgraph Blockchain & Web3 Integration
        Services --> Soroban[Stellar Soroban RPC Node]
        Soroban --> Contracts[Soroban Smart Contracts: Artist Profile, Catalog NFT, Marketplace]
    end
```

---

## Module Responsibility Guide

The `src/` codebase is organized into distinct domain layers, each with strict responsibilities:

| Module Directory             | Responsibility                                                                                                                                      | Key Files & Artifacts                                                                                                    |
| :--------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------- |
| `src/app.ts`                 | Express application setup, global middleware registration, security headers, rate limiting, and main router attachment.                             | `app.ts`, `index.ts`                                                                                                     |
| `src/config/`                | Centralized environment variables, database configuration, Redis client initialization, AWS/IPFS options, and constants.                            | `config/db.ts`, `config/redis.ts`, `config/constants.ts`                                                                 |
| `src/controllers/`           | Thin HTTP controllers responsible ONLY for parsing request params/body, invoking services, and returning status codes.                              | `AuthController.ts`, `SongController.ts`, `ReleaseController.ts`, `RoyaltyTemplateController.ts`, `WalletController.ts`  |
| `src/services/`              | Business logic domain layer containing transaction rules, validation, external Web3/S3 integration, and cross-service coordination.                 | `AuthService.ts`, `SongService.ts`, `SorobanService.ts`, `ScanService.ts`, `MarketplaceService.ts`, `ServiceRegistry.ts` |
| `src/entities/`              | TypeORM database entity definitions mapping TypeScript classes to PostgreSQL tables with column decorators and relations.                           | `User.ts`, `Song.ts`, `Album.ts`, `RoyaltyPayout.ts`, `SongCollaborator.ts`, `Release.ts`, `Tag.ts`                      |
| `src/dtos/`                  | Data Transfer Objects defining strict request validation schemas using `class-validator` and `class-transformer`.                                   | `RegisterUserDto.ts`, `LoginDto.ts`, `CreateSongDto.ts`, `UpdateProfileDto.ts`                                           |
| `src/middlewares/`           | Express middlewares for JWT authentication, RBAC authorization, DTO validation, rate limiting, malware scanning, request logging, and sanitization. | `authMiddleware.ts`, `validate.ts`, `authRateLimiter.ts`, `sanitizeInput.ts`, `bodySizeLimit.ts`                         |
| `src/workers/` & `src/jobs/` | Asynchronous job queues and background workers for CPU-intensive audio transcoding (FFmpeg HLS), malware scans, and payout processing.              | `QueueManager.ts`, `Worker.ts`, `JobHandler.ts`                                                                          |
| `src/routes/`                | Express router definitions wiring HTTP paths and HTTP methods to specific middlewares and controller handlers.                                      | `authRoutes.ts`, `songRoutes.ts`, `releaseRoutes.ts`, `royaltyRoutes.ts`                                                 |
| `src/errors/`                | Application-wide error class (`AppError`) handling operational failures, status codes, error codes, and field details.                              | `errors/AppError.ts`                                                                                                     |

---

## Key Feature Code Flows

### 1. Artist Authentication & Web3 Wallet Onboarding Flow

```mermaid
sequenceDiagram
    autonumber
    participant Artist as Client / Wallet
    participant Router as AuthRoutes
    participant MW as AuthMiddleware
    participant Service as AuthService
    participant Soroban as SorobanService
    participant DB as Postgres DB

    Artist->>Router: POST /api/auth/nonce (walletAddress)
    Router->>Service: generateNonce(walletAddress)
    Service->>DB: Save nonce to Redis / DB
    Service-->>Artist: Return random challenge nonce
    Artist->>Artist: Sign nonce with Stellar/Freighter wallet key
    Artist->>Router: POST /api/auth/verify-signature (walletAddress, signature)
    Router->>Service: verifySignature(walletAddress, signature)
    Service->>DB: Find or create User record
    Service->>Soroban: Query artist profile contract on Stellar
    Service-->>Artist: Return JWT Access & Refresh Tokens
```

### 2. Song Upload & HLS Transcoding Flow

```mermaid
sequenceDiagram
    autonumber
    participant Artist as Client
    participant UploadMW as Multer / BodySizeLimit
    participant ScanMW as ScanService (ClamAV)
    participant Controller as SongController
    participant Service as SongService
    participant Worker as TranscodeWorker (FFmpeg)
    participant S3 as AWS S3 / IPFS

    Artist->>UploadMW: POST /api/songs/upload (multipart audio file)
    UploadMW->>ScanMW: Scan buffer for malware
    alt Malware Detected
        ScanMW-->>Artist: 422 Unprocessable Entity (Malware Detected)
    else Clean Audio
        ScanMW->>Controller: File approved
        Controller->>Service: uploadSong(artistId, file, dto)
        Service->>S3: Upload original master audio (.wav/.mp3)
        Service->>Worker: Enqueue HLS Transcode Job
        Worker->>Worker: Re-encode to AAC-LC & generate HLS .m3u8 playlist & fMP4 segments
        Worker->>S3: Upload HLS playlist & segments
        Worker->>S3: Pin metadata & audio to IPFS
        Service->>DB: Set song status = 'ready'
    end
```

The worker never copies the uploaded codec. `transcodeToHLS` (`src/utils/ffmpeg.ts`) re-encodes every upload (MP3, WAV, FLAC, AAC/M4A, OGG) so listeners always receive the same format:

- **Codec:** AAC-LC, 44.1 kHz, at `HLS_AUDIO_BITRATE` (default `256k`). Embedded cover art and video streams are dropped (`-vn`).
- **Segments:** 10 second fMP4 segments (`init.mp4` + `.m4s`) rather than MPEG-TS. fMP4 plays gaplessly, avoids per-segment TS timestamp discontinuities, and is supported by Safari/iOS native HLS and hls.js.
- **Validation:** the chunk upload endpoint only accepts MP3, WAV, FLAC, OGG, AAC and M4A, and rejects other types with a clear message before any processing.

### 3. Soroban NFT Song Minting Relay Flow

```mermaid
sequenceDiagram
    autonumber
    participant Client as Client Dashboard
    participant Controller as SongController
    participant Service as SongService
    participant Soroban as SorobanService / RPC

    Client->>Controller: POST /api/songs/:id/mint/prepare
    Controller->>Service: prepareSongMintTx(songId, artistAddress)
    Service->>Soroban: Build unsigned Soroban mint transaction XDR
    Service-->>Client: Return unsigned XDR payload
    Client->>Client: Sign XDR with Freighter wallet
    Client->>Controller: POST /api/songs/:id/mint/submit (signedXdr)
    Controller->>Service: submitSongMintTx(signedXdr)
    Service->>Soroban: Submit transaction to Stellar network
    Soroban-->>Service: Return onChainSongId & token_id
    Service->>DB: Update song mintStatus = 'minted'
```

---

## Architecture Decision Records (ADRs)

For in-depth context on key design choices and trade-offs, refer to the decision records in `docs/adrs/`:

- **[ADR 001: Authentication Strategy](file:///Users/sam/Desktop/Drips/AudioBlock_Backend/docs/adrs/001-authentication-strategy.md)** — Dual authentication supporting Stellar wallet signature nonces and email+password with 2FA TOTP.
- **[ADR 002: Blockchain Integration](file:///Users/sam/Desktop/Drips/AudioBlock_Backend/docs/adrs/002-blockchain-integration.md)** — Client-side signing with Soroban backend transaction relay pattern.
- **[ADR 003: File Storage Strategy](file:///Users/sam/Desktop/Drips/AudioBlock_Backend/docs/adrs/003-file-storage-strategy.md)** — AWS S3 for master audio & HLS streaming paired with IPFS/Pinata for immutable metadata CIDs.
- **[ADR 004: Background Job Processing](file:///Users/sam/Desktop/Drips/AudioBlock_Backend/docs/adrs/004-background-job-processing.md)** — Priority job queue and worker pattern for asynchronous transcoding and malware scans.
- **[ADR 005: Database & ORM Selection](file:///Users/sam/Desktop/Drips/AudioBlock_Backend/docs/adrs/005-database-and-orm.md)** — PostgreSQL with TypeORM for relational data integrity, migrations, and strict entity typing.
