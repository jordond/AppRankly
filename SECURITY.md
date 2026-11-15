# Security Policy

AppRankly is designed as a **self-hosted, privacy-first** application for managing and analyzing mobile app performance. Because AppRankly manages sensitive authentication credentials—such as Google Cloud Storage service account JSON keys, Apple App Store Connect `.p8` private keys, and AI provider API keys—we take security extremely seriously.

---

## Supported Versions

Only the latest release and the current `main` branch receive security updates and patches. We strongly encourage all operators to keep their AppRankly instance updated.

| Version | Supported          |
| ------- | ------------------ |
| latest (`main` branch) | :white_check_mark: |
| < 1.0.0 | :x:                |

---

## Reporting a Vulnerability

If you discover a potential security vulnerability in AppRankly, please report it responsibly. **Do NOT open a public GitHub issue for security vulnerabilities.**

### How to Report

Please report security vulnerabilities by emailing the maintainer directly or opening a **Private Security Advisory** on GitHub:

- **GitHub Private Advisory**: Go to the repository's **Security** tab → **Advisories** → **New draft advisory**.
- **Email**: Reach out to the maintainer via GitHub profile contact details.

### What to Include in Your Report
- A detailed description of the vulnerability.
- Proof-of-concept (PoC) code or step-by-step instructions to reproduce the issue.
- Potential impact of the issue (e.g., unauthorized data access, privilege escalation).
- Any proposed remediation or patch if available.

### Response Timeline
- **Acknowledgement**: Within 48 hours of report submission.
- **Assessment & Fix**: We will work to verify and release a fix as promptly as possible.
- **Public Disclosure**: A public advisory will be published once a patch is made available.

---

## Security Best Practices for Self-Hosting

When operating AppRankly on your server, container, or cloud instance, please follow these security guidelines:

### 1. Protect Your Credentials & Configuration
- **Keep Secrets Out of Version Control**: `config.json` and files in the `config/keys/` (or `data/config/keys/`) folder contain sensitive API keys. They are listed in `.gitignore` by default. **Never commit key files or configuration files to Git.**
- **Set a Custom `JWT_SECRET`**: In production environments, explicitly set the `JWT_SECRET` environment variable to a strong, randomly generated string (e.g., `openssl rand -hex 32`). Do not rely on dynamic fallbacks in multi-container setups.
- **Set an Admin Password**: Complete the first-run setup screen, or set the `ADMIN_PASSWORD` environment variable (plaintext or a bcrypt hash). Until a password exists, every API route returns `401`, because those routes can read and write `config.json` and its keys. Setting `ALLOW_UNAUTHENTICATED=true` reopens the API without a password; use it only when AppRankly is reachable solely through your own authentication proxy.

### 2. Follow Principle of Least Privilege
- **Google Cloud Service Account**: Grant only the minimal permission required (*"View app information and download bulk reports (read-only)"*) in Google Play Console.
- **Apple App Store Connect Key**: Assign the lowest required role (*"Sales and Reports"*) when creating API keys in App Store Connect.
- **Store Status keys (optional feature)**: The Store Status page needs more than the analytics minimum: an App Store Connect key with an app role (such as *"App Manager"* or *"Admin"*; tested with Admin), and for Google the extra *"View app quality information (read-only)"* permission. To keep the analytics key at *"Sales and Reports"*, give store status its own key under `storeStatus.apple`. AppRankly only sends read requests to App Store Connect, whatever role the key has, but a key with an app role can do more than read if it leaks, so protect it accordingly.
- **Play rollout percentage (opt-in)**: `storeStatus.google.readRolloutViaEdits` makes AppRankly open and delete a Play edit to read rollout percentage. It never changes or commits an edit, but opening one invalidates any other open edit of the same service account. Use a service account dedicated to AppRankly, never one shared with CI, and leave the option off if you do not need it.
- **AI Provider Keys**: Consider placing usage limits or spending caps on your OpenAI, Anthropic, or Gemini API keys.

### 3. Network & Transport Security
- **Use HTTPS / Reverse Proxy**: Always deploy AppRankly behind a TLS-terminating reverse proxy (such as Nginx, Caddy, Traefik, or Cloudflare Tunnels) when accessing the dashboard over the public internet.
- **Restrict Access**: Place AppRankly behind authentication proxies (e.g., Authelia, Cloudflare Zero Trust, or VPN/Tailscale) if hosting on public infrastructure.

### 4. Container & System Security
- AppRankly Docker images are configured to run as a **non-root user** (`UID 1000:1000`). Avoid running the container with `--privileged` or as root unless strictly necessary.
- Regularly update Docker base images and system packages.

---

Thank you for helping keep AppRankly and its user community safe!
