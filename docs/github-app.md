# GitHub sign-in for the history backend

People sign in to the backend with GitHub (`toolreader history login`). The backend then lets
them read a repo's history only when GitHub, asked with their own token, says they can read the
repo. The backend never holds more access than the person has.

Whether this goes through a **GitHub App** (Astra's recommendation) or an **OAuth App** is
decision D9. Both work: the backend only needs a client id that supports the device flow.

## A GitHub App (recommended)

1. **Create the App.** Do it under the organization that owns the pilot repos: GitHub → Settings →
   Developer settings → GitHub Apps → New GitHub App.
   - **Name:** for example `toolreader-history-<org>`.
   - **Homepage URL:** the backend's URL.
   - **Callback URL:** not used. The device flow needs none, but GitHub requires a value, so give
     the homepage.
   - **Enable Device Flow:** on. `history login` uses it.
   - **Webhook:** off.
   - **Repository permissions:** `Metadata: Read-only` only. That's what lets the user's token
     answer `GET /repos/{owner}/{repo}`. Ask for nothing else: the backend reads history from its
     own database, never code from GitHub.
   - **Where can this App be installed:** only on this account.
2. **Install it.** Install the App on the organization, with **Only select repositories**: the
   pilot repos. A user's token then sees a repo only when the App is installed on it _and_ the
   user can read it. That's the "selected repositories ∩ the user's own access" rule.
3. **Point the backend at it.** Copy the App's **Client ID**: it's public, unlike the client
   secret. Start the backend with:
   ```bash
   TOOLREADER_GITHUB_CLIENT_ID=<client id> toolreader backend serve
   ```
   On GitHub Enterprise Server, also set `TOOLREADER_GITHUB_API=https://<host>/api/v3` and
   `TOOLREADER_GITHUB_WEB=https://<host>`.
4. **Let people in.** Add each pilot member's GitHub login:
   ```bash
   toolreader backend member add --workspace <slug> --github <login>
   ```
5. **Each person signs in once:**
   ```bash
   toolreader history login
   ```
   The token is kept in `~/.toolreader/config.json` as `backend.githubToken`, readable only by
   its owner. Search, `history show`, the history page and Insights then go as that person.
   Syncing keeps using the workspace token (`backend.token`), which the hooks need.

The App's private key and client secret aren't used. Don't generate them, or delete them if
GitHub made them.

## An OAuth App (the alternative)

Settings → Developer settings → OAuth Apps → New OAuth App, with **Enable Device Flow** on. Its
tokens carry the user's own access to every repo they can read; there's no selection of
repositories. The backend's per-repo check is the same. The difference is that the App-level
"only these repos" boundary is gone. Configure it with the same `TOOLREADER_GITHUB_CLIENT_ID`.

## Revoking access

- **A person loses a repo on GitHub:** within a minute the backend refuses them that repo (its
  answers are cached a minute).
- **A person leaves the pilot:**
  `toolreader backend member remove --workspace <slug> --github <login>`. They're refused at
  once.
- **A machine's workspace token leaks:**
  `toolreader backend token revoke --workspace <slug> --name <name>`.
- **Someone asks for a session to be deleted:**
  `toolreader backend thread delete --workspace <slug> --id <thread>`.
