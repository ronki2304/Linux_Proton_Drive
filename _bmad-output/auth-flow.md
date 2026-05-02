# Auth Flow

Authentication between the Python UI and Proton's identity service, with token handoff to the TypeScript Engine.

---

## Sequence

```mermaid
sequenceDiagram
    participant User
    participant UI as Python UI
    participant Server as AuthCallbackServer
    participant WV as WebKitGTK
    participant Proton as account.proton.me
    participant Engine as TypeScript Engine

    Note over UI,Server: Server MUST bind before WebView navigates

    UI->>Server: bind 127.0.0.1:0 (ephemeral port)
    UI->>Server: start_async on background thread
    UI->>WV: create WebView with JS injection at document-start
    UI->>WV: load_uri http://127.0.0.1:{port}/auth-start

    WV->>Server: GET /auth-start
    Server-->>WV: 302 → https://account.proton.me?redirect_uri=.../callback

    WV->>Proton: navigate (allow all subdomains — no URL filter)

    Note over WV: JS active: captures password input<br/>intercepts fetch + XHR responses

    UI->>UI: start cookie poll every 2s for AUTH-{UID} cookie

    User->>WV: enters email + password

    WV->>UI: protonCapture: auth_success {loginPassword}
    WV->>UI: protonCapture: key_salts {keySalts}

    opt 2FA required
        User->>WV: enters 2FA code
        Note over Proton: scope upgraded server-side<br/>same cookie value, new scope
    end

    alt Cookie poll detects AUTH-{UID}
        UI->>UI: extract uid + accessToken → "uid:accesstoken"
    else Proton redirects to /callback
        Server-->>UI: token via callback handler
    end

    UI->>Engine: token_refresh {token, login_password?, captured_salts?, key_password?}
    UI->>Server: stop() — one-shot, closed after token extracted

    alt Stored key_password valid
        Engine->>UI: session_ready
    else Silent unlock via captured login_password + salts
        Engine->>UI: session_ready {key_password}
    else Keys need manual password
        Engine->>UI: key_unlock_required
        User->>UI: enters Proton mailbox password
        UI->>Engine: unlock_keys {password}
        Engine->>UI: session_ready {key_password}
    else Token rejected
        Engine->>UI: token_expired {queued_changes}
        Note over UI: mark_last_token_rejected()<br/>same token retried after 8s<br/>(2FA scope upgrade window)
    end

    UI->>UI: mark_auth_complete()
    UI->>WV: try_close() + remove
    Note over WV: Cookies kept — persistent session<br/>no 2FA prompt on next launch

    Note over UI,Engine: Re-auth (token expired during sync)
    Engine->>UI: token_expired {queued_changes:N}
    UI->>User: re-auth modal showing queued_changes count
    User->>UI: confirms re-auth
    UI->>UI: start_auth() — same flow from top
```

---

## Security Boundaries

- **Auth server binds to `127.0.0.1` only** — never `0.0.0.0`; not reachable from the network.
- **One-shot server** — closes immediately after the first token is extracted; leaving it running would be a security hole.
- **No URL filtering in WebView** — Proton redirects through multiple subdomains (`account.proton.me`, `mail.proton.me/api`, etc.); the security boundary is the localhost callback server, not URL filtering.
- **Token never logged** — `log_message` on the callback handler is suppressed to prevent the token leaking via the query string into logs.
- **Cookies kept on teardown** — persistent WebKit session so the user is not prompted for 2FA on every app launch.

## Key Data Captured by JS Injection

| Field | Source | Purpose |
|-------|--------|---------|
| `login_password` | `<input type="password">` events | Silent key derivation via bcrypt (avoids manual password dialog) |
| `captured_salts` | `GET /core/v4/keys/salts` response | Per-key bcrypt salts; only available with locked-scope token (pre-2FA window) |
| `auth_key_salt` | `POST /core/v4/auth` response | Legacy single-salt fallback for older accounts |
