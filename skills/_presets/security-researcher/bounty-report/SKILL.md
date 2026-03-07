---
name: bounty-report
description: Write professional bug bounty reports with clear reproduction steps, impact analysis, CVSS scoring, and remediation guidance.
triggers: bug bounty report, write report, vulnerability report, hackerone report, bugcrowd report, security report, disclosure report, write finding, report vulnerability, submit bug
---

# Bug Bounty Report Writing

Use this skill to write professional vulnerability reports suitable for bug bounty platforms (HackerOne, Bugcrowd, Intigriti) or responsible disclosure. A good report maximizes the chance of acceptance and fair payout by being clear, reproducible, and well-structured.

## Tools Required

- `write_to_blackboard` — store the report
- `file_write` — save report as markdown file
- `web_search` — research CVSS scoring, similar reports, CWE classifications
- `read_from_blackboard` — retrieve scan results and findings from prior analysis

## What Makes a Great Bug Bounty Report

1. **Clear title** — vulnerability type + affected component
2. **Immediate impact statement** — what an attacker can do, in one sentence
3. **Reproducible steps** — exact curl commands, URLs, parameters
4. **Evidence** — screenshots, HTTP request/response pairs, tool output
5. **Impact analysis** — business impact, data at risk, user count affected
6. **CVSS score** — justified with vector string
7. **Remediation** — specific, actionable fix

## Report Template

```markdown
# [Vulnerability Type] in [Component/Endpoint]

## Summary
[One paragraph: what the vulnerability is, where it exists, and what an attacker can achieve by exploiting it.]

## Severity
- **CVSS 3.1 Score**: [X.X] ([Low/Medium/High/Critical])
- **Vector**: CVSS:3.1/AV:[N/A/L/P]/AC:[L/H]/PR:[N/L/H]/UI:[N/R]/S:[U/C]/C:[N/L/H]/I:[N/L/H]/A:[N/L/H]
- **CWE**: CWE-[XXX] — [Name]

## Affected Asset
- **URL/Endpoint**: `https://TARGET.com/api/endpoint`
- **Parameter**: `user_id` (query parameter)
- **Component**: [API, web app, mobile, infrastructure]
- **In-scope**: [Yes — per program scope definition]

## Steps to Reproduce

### Prerequisites
- [Account type needed, if any]
- [Any setup required]

### Reproduction
1. Navigate to `https://TARGET.com/login` and authenticate as a normal user.
2. Open browser developer tools → Network tab.
3. Navigate to `https://TARGET.com/api/profile?user_id=YOUR_ID`.
4. Change the `user_id` parameter to another user's ID:
   ```
   curl -H "Authorization: Bearer YOUR_TOKEN" \
     "https://TARGET.com/api/profile?user_id=VICTIM_ID"
   ```
5. Observe: the API returns the victim's full profile data including email and phone number.

### Expected Behavior
The API should return `403 Forbidden` when accessing another user's profile.

### Actual Behavior
The API returns `200 OK` with the victim user's full profile data, including PII.

## Proof of Concept

### HTTP Request
```http
GET /api/profile?user_id=12346 HTTP/2
Host: TARGET.com
Authorization: Bearer eyJhbGci...
```

### HTTP Response
```http
HTTP/2 200
Content-Type: application/json

{
  "id": 12346,
  "name": "Victim User",
  "email": "victim@example.com",
  "phone": "+1-555-0123",
  "address": "123 Main St..."
}
```

## Impact

### Technical Impact
- **Confidentiality**: High — full PII disclosure (email, phone, address)
- **Integrity**: None
- **Availability**: None

### Business Impact
- Any authenticated user can enumerate and access all user profiles.
- Exposed data includes PII subject to GDPR/CCPA regulations.
- Estimated affected users: [all registered users / N users].

### Attack Scenario
An attacker with a free account could write a script to iterate through user IDs (sequential integers), harvesting the personal data of every user on the platform in minutes. This data could be used for phishing, identity theft, or sold on the dark web.

## Remediation

### Recommended Fix
Implement server-side authorization checks on the `/api/profile` endpoint:
```python
# Before returning profile data
if request.user.id != requested_user_id:
    if not request.user.is_admin:
        return HttpResponseForbidden()
```

### Additional Recommendations
- Switch to UUIDs instead of sequential integer IDs to prevent enumeration.
- Implement rate limiting on the endpoint.
- Add access logging to detect bulk enumeration attempts.

## References
- [CWE-639: Authorization Bypass Through User-Controlled Key](https://cwe.mitre.org/data/definitions/639.html)
- [OWASP: Insecure Direct Object Reference (IDOR)](https://owasp.org/www-project-web-security-testing-guide/)
- [Similar report: HackerOne #XXXXX] (if applicable)
```

## CVSS 3.1 Quick Reference

Use the CVSS calculator logic to score. Common patterns:

| Vulnerability | Typical Score | Vector |
|---|---|---|
| IDOR (PII disclosure) | 6.5 Medium | AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N |
| Stored XSS | 6.1 Medium | AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N |
| SQL Injection (data) | 8.6 High | AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:N/A:N |
| SQL Injection (RCE) | 9.8 Critical | AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H |
| SSRF (internal) | 7.5 High | AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N |
| Open redirect | 4.7 Medium | AV:N/AC:L/PR:N/UI:R/S:C/C:N/I:L/A:N |
| Info disclosure (minor) | 5.3 Medium | AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N |
| Auth bypass | 9.8 Critical | AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H |
| CSRF (state change) | 4.3 Medium | AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:N |
| Subdomain takeover | 7.2 High | AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:L/A:N |

## CWE Quick Reference

| Vulnerability Type | CWE |
|---|---|
| IDOR | CWE-639 |
| XSS (Stored) | CWE-79 |
| XSS (Reflected) | CWE-79 |
| SQL Injection | CWE-89 |
| Command Injection | CWE-78 |
| SSRF | CWE-918 |
| Open Redirect | CWE-601 |
| CSRF | CWE-352 |
| Auth Bypass | CWE-287 |
| Info Disclosure | CWE-200 |
| Path Traversal | CWE-22 |
| Subdomain Takeover | CWE-284 |
| Broken Access Control | CWE-284 |
| Insecure Deserialization | CWE-502 |

## Report Quality Checklist

Before submitting, verify:

- [ ] Title is specific: vulnerability type + component (not "Bug in website")
- [ ] Summary explains impact in one sentence
- [ ] Steps to reproduce are numbered and specific (exact URLs, parameters, values)
- [ ] PoC includes raw HTTP requests and responses
- [ ] Impact covers both technical and business dimensions
- [ ] CVSS score is justified with the vector string
- [ ] CWE classification is included
- [ ] Remediation is specific and actionable (not just "fix the bug")
- [ ] No sensitive data from other users is included in the report
- [ ] Report is self-contained — a developer can reproduce without asking questions

## Platform-Specific Tips

### HackerOne
- Use their severity dropdown (maps to CVSS ranges)
- Add relevant weakness type from their dropdown (maps to CWE)
- Attach files (screenshots, scripts) as attachments, not inline
- Follow up on triage questions within 48 hours

### Bugcrowd
- Follow their Vulnerability Rating Taxonomy (VRT) for severity
- Link to VRT category in your report
- Use their structured template if provided

## Guardrails

1. Never include credentials, tokens, or PII of real users in reports. Redact sensitive values.
2. Do not include exploit scripts that cause damage — PoC should demonstrate the issue with minimal impact.
3. If the finding involves user data, use only your own test accounts as evidence.
4. Always check the program's disclosure policy before sharing details externally.
5. For chained vulnerabilities, describe each step of the chain clearly.
