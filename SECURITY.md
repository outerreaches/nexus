# Security Audit Tools for Nexus

This document describes the security scanning tools configured for the Nexus codebase and how to use them.

## Overview

Nexus uses a multi-layered security approach:

| Tool | Purpose | Type |
|------|---------|------|
| ESLint + security plugin | Development-time security checks | SAST |
| npm audit | Dependency vulnerability scanning | SCA |
| Semgrep | Static application security testing | SAST |
| Gitleaks | Secret detection | Secret Scanning |

## Quick Start

### Install Dependencies
```bash
npm install
```

### Run All Security Scans
```bash
npm run security:all
```

## Individual Tools

### 1. ESLint with Security Plugin

Checks for common security issues in JavaScript/TypeScript code during development.

```bash
# Run linting
npm run lint

# Auto-fix issues where possible
npm run lint:fix
```

**What's detected:**
- `eval()` usage
- `dangerouslySetInnerHTML` usage
- Command injection risks
- Weak cryptographic algorithms
- Insecure random number generation
- Path traversal risks

### 2. npm Audit

Built-in npm dependency vulnerability scanner.

```bash
# Check for vulnerabilities
npm run security:audit

# Auto-fix vulnerabilities
npm run security:audit:fix
```

**Configuration:** The audit runs at "high" severity level by default.

### 3. Semgrep

Advanced static analysis with community-curated security rules.

```bash
# Run semgrep with repository rules (semgrep.yml)
npm run security:semgrep

# Docker fallback (if semgrep is not installed locally)
npm run security:semgrep:docker
```

**What's detected:**
- Code injection vulnerabilities
- SQL injection
- Path traversal
- XXE vulnerabilities
- Hardcoded secrets
- And many more OWASP Top 10 issues

### 4. Gitleaks

Scans for secrets accidentally committed to the repository.

```bash
# Run gitleaks
npm run security:gitleaks

# Docker fallback (if gitleaks is not installed locally)
npm run security:gitleaks:docker
```

**What's detected:**
- AWS access keys
- GitHub tokens
- Slack tokens
- Stripe API keys
- Private keys
- Database connection strings
- JWT tokens

## CI/CD Integration

A GitHub Actions workflow is configured at `.github/workflows/security.yml`.

### Secrets Required

For full CI/CD functionality, add these secrets to your GitHub repository:

| Secret | Purpose |
|--------|---------|
| `SNYK_TOKEN` | Snyk dependency monitoring (optional) |

### Running Locally Without Secrets

The workflow will still run without secrets - some steps may be skipped or use local-only modes.

## Scheduled Scans

The workflow runs:
- On every push to `main` or `develop`
- On every pull request to `main`
- Weekly on Sunday at 2 AM
- Manually via `workflow_dispatch`

## Adding Snyk (Optional)

To add Snyk for enhanced dependency monitoring:

```bash
# Install Snyk CLI
npm install -g snyk

# Authenticate
snyk auth

# Test configuration
snyk test

# Add to CI/CD (uncomment in security.yml)
# Uses: snyk/actions/node@master
```

## Best Practices

1. **Run security scans before committing:**
   ```bash
   npm run security:all
   ```

2. **Use pre-commit hooks:**
   ```bash
   npx husky install
   # or use semgrep's built-in hook
   npm run postinstall
   ```

3. **Fix vulnerabilities promptly:**
   ```bash
   npm run security:audit:fix
   ```

4. **Review security findings regularly:**
   - Check GitHub Security tab
   - Review PR security checks
   - Monitor dependency updates

## Troubleshooting

### "command not found: semgrep"
```bash
npm install -g semgrep
```

### "command not found: gitleaks"
```bash
# macOS
brew install gitleaks

# Linux
wget https://github.com/zricethezav/gitleaks/releases/download/v8.18.2/gitleaks_v8.18.2_linux_x64.tar.gz
tar -xzf gitleaks_v8.18.2_linux_x64.tar.gz
sudo mv gitleaks /usr/local/bin/
```

### ESLint errors about TypeScript
```bash
# Ensure TypeScript ESLint is properly installed
npm install
```

## Exit Codes

- `0` - Scan passed / No issues found
- `1` - Issues found (for most tools)
- `2` - Configuration error

## Reporting Security Issues

If you find a security vulnerability, please:
1. Do NOT open a public GitHub issue
2. Email the maintainers directly
3. Or use GitHub's private vulnerability reporting

---

*Last updated: February 2025*
