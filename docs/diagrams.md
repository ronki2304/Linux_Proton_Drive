# ProtonDrive Linux Client — Diagrams

**Date:** 2026-04-05

---

## 1. Global Flow

Overall CLI execution lifecycle — from user invocation to exit.

```mermaid
flowchart TD
    User(["User"]) -->|"protondrive &lt;cmd&gt;"| CLI["cli.ts\nCommander"]

    CLI --> Route{Command?}

    Route -->|"auth login"| AuthLogin["auth-login.ts"]
    Route -->|"auth logout"| AuthLogout["auth-logout.ts"]
    Route -->|"upload"| Upload["upload.ts"]
    Route -->|"download"| Download["download.ts"]
    Route -->|"sync"| Sync["sync.ts"]
    Route -->|"status"| Status["status.ts"]

    AuthLogin --> SRP["srp.ts\nSRP challenge/response"]
    SRP --> ProtonAPI(["Proton API"])
    ProtonAPI --> StoreCred["credentials.ts\nstore accessToken"]
    StoreCred --> Keychain[("OS Keychain")]

    AuthLogout --> ClearCred["credentials.ts\nclear token"]
    ClearCred --> Keychain

    Upload --> GetToken1["credentials.ts\nget token"]
    GetToken1 --> Keychain
    GetToken1 --> UploadSDK["DriveClient\nuploadFile"]
    UploadSDK --> openpgp["openpgp-proxy.ts\nencrypt"]
    openpgp --> ProtonAPI

    Download --> GetToken2["credentials.ts\nget token"]
    GetToken2 --> Keychain
    GetToken2 --> DownloadSDK["DriveClient\ndownloadFile"]
    DownloadSDK --> ProtonAPI
    DownloadSDK --> Decrypt["openpgp-proxy.ts\ndecrypt"]
    Decrypt --> LocalFS[("Local FS")]

    Sync --> LoadCfg1["config.ts\nload config.yaml"]
    Sync --> GetToken3["credentials.ts\nget token"]
    GetToken3 --> Keychain
    Sync --> SyncEngine["sync-engine.ts\ndiff + apply"]
    SyncEngine --> StateDB1[("SQLite\nState DB")]
    SyncEngine --> ConflictRes["conflict.ts\nresolve conflicts"]
    SyncEngine --> ProtonAPI

    Status --> LoadCfg2["config.ts\nload config.yaml"]
    Status --> StateDB2[("SQLite\nState DB")]
    Status --> Output["output.ts\nformat + print"]

    Output --> User
    UploadSDK -->|"success/error"| User
    DownloadSDK -->|"success/error"| User
    SyncEngine -->|"result"| User
    StoreCred -->|"Logged in"| User
    ClearCred -->|"Logged out"| User
```

---

## 2. High-Level Design (HLD)

Component architecture — four layers and external systems.

```mermaid
graph TD
    subgraph Entry["Entry Point"]
        CLI["cli.ts\n(Commander program)"]
    end

    subgraph Commands["Commands Layer — src/commands/"]
        AL["auth-login.ts"]
        AO["auth-logout.ts"]
        UP["upload.ts"]
        DL["download.ts"]
        SY["sync.ts"]
        ST["status.ts"]
    end

    subgraph AuthLayer["Auth Layer — src/auth/"]
        CRED["credentials.ts\nCredentialStore interface"]
        SRP["srp.ts\nSRP protocol"]
        KS["keyring-store.ts\nOS keychain impl"]
        FS["file-store.ts\nFile fallback impl"]
    end

    subgraph CoreLayer["Core Layer — src/core/"]
        CFG["config.ts\nYAML config"]
        ENG["sync-engine.ts\ndiff + reconcile"]
        SDB["state-db.ts\nbun:sqlite"]
        CON["conflict.ts\nconflict resolution"]
        OUT["output.ts\nterminal formatting"]
    end

    subgraph SDKLayer["SDK Layer — src/sdk/"]
        DC["client.ts\nDriveClient"]
        ACC["account-service.ts"]
        PGP["openpgp-proxy.ts\ntype bridge"]
        SRPM["srp-module.ts\ncrypto helpers"]
    end

    subgraph External["External Systems"]
        API(["Proton API"])
        CHAIN[("OS Keychain\nGNOME/KWallet")]
        DB[("SQLite\nState DB")]
        YAML[/"~/.config/protondrive\n/config.yaml"/]
        LCLFS[/"Local Filesystem"/]
    end

    CLI --> Commands
    Commands --> AuthLayer
    Commands --> CoreLayer

    AL --> SRP
    AL --> CRED
    AO --> CRED
    CRED --> KS
    CRED --> FS
    KS --> CHAIN
    FS --> LCLFS

    SY --> CFG
    ST --> CFG
    CFG --> YAML

    SY --> ENG
    ENG --> SDB
    ENG --> CON
    SDB --> DB

    UP --> LCLFS
    DL --> LCLFS

    Commands --> SDKLayer
    CoreLayer --> SDKLayer
    AuthLayer --> SDKLayer

    DC --> PGP
    DC --> API
    ACC --> API
    SRP --> SRPM
    SRPM --> ACC
```

---

## 3. Sequence / Low-Level Design (SLD) — Sync Flow

Detailed component interaction for `protondrive sync` — the most complex operation.

```mermaid
sequenceDiagram
    actor User
    participant CLI as cli.ts
    participant SyncCmd as sync.ts
    participant Config as config.ts
    participant Creds as credentials.ts
    participant Keychain as OS Keychain
    participant Engine as sync-engine.ts
    participant DB as state-db.ts
    participant Conflict as conflict.ts
    participant Client as DriveClient
    participant PGP as openpgp-proxy.ts
    participant API as Proton API

    User->>CLI: protondrive sync
    CLI->>SyncCmd: action()

    note over SyncCmd,Config: Config-first, fail-fast (no network until config validated)
    SyncCmd->>Config: loadConfig(path?)
    Config-->>SyncCmd: Config { sync_pairs, options }

    SyncCmd->>Creds: getSessionToken()
    Creds->>Keychain: get("session")
    Keychain-->>Creds: accessToken
    Creds-->>SyncCmd: accessToken

    SyncCmd->>DB: StateDB.init()
    DB-->>SyncCmd: stateDb

    SyncCmd->>Engine: engine.run(sync_pairs, token, client)

    loop For each sync_pair
        Engine->>Client: listFolder(remote)
        Client->>API: GET remote listing
        API-->>Client: remote items[]
        Client-->>Engine: remoteItems[]

        Engine->>DB: getAll(pair.id)
        DB-->>Engine: lastKnownState[]

        Engine->>Engine: diff(local, remote, lastKnownState)

        alt Local change only
            Engine->>PGP: encrypt(fileContent)
            PGP-->>Engine: encryptedPayload
            Engine->>Client: uploadFile(localPath, remotePath)
            Client->>API: PUT encrypted file
            API-->>Client: ok
            Engine->>DB: update(pair.id, "synced")
        else Remote change only
            Engine->>Client: downloadFile(remotePath, tmpPath)
            Client->>API: GET file
            API-->>Client: encryptedPayload
            Client->>PGP: decrypt(encryptedPayload)
            PGP-->>Client: fileContent
            Client-->>Engine: written to tmpPath → renamed atomically
            Engine->>DB: update(pair.id, "synced")
        else Conflict — changed on both sides
            Engine->>Conflict: resolve(localFile, remoteFile)
            Conflict-->>Engine: ConflictRecord { original, conflictCopy }
            note over Engine: keeps both versions locally
            Engine->>DB: update(pair.id, "conflict")
        else No change
            Engine->>DB: update(pair.id, "synced")
        end
    end

    Engine-->>SyncCmd: SyncResult { transferred, conflicts[], errors[] }

    alt No errors
        SyncCmd->>User: "Sync complete: N file(s) transferred, M conflict(s)"
    else Errors present
        SyncCmd->>User: errors printed to stderr
        SyncCmd->>CLI: process.exit(1)
    end

    SyncCmd->>DB: stateDb.close()
```

---

_Generated using BMAD Method `bmad-agent-tech-writer` — MG capability_
