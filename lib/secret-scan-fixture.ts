/**
 * Cross-repo secret-scan fixture, rules_version 1.
 *
 * THE ANTI-DRIFT GUARD. The secret-scan gate is implemented twice: once in
 * the platform backend (backend/src/agent-handoffs/secret-scan.util.ts, jest)
 * and once in the Claude Code plugin (lib/secret-scan.ts, node/bun test).
 * The n8n packaging path runs the first, the claude-code path runs the second.
 * If they disagree, one path blocks a pack the other happily ships, which is
 * how a secret leaks.
 *
 * This file holds the SAME corpus and the SAME expected findings in both
 * repos. Each repo's spec runs ITS scanner over this corpus and asserts the
 * exact findings, then asserts the two digests below. Formatting may follow
 * each repo's lint, but the DATA is pinned: change a rule name, a rule order,
 * a regex, or the corpus in one repo only, and that repo's suite goes red.
 *
 * To change the ruleset: update BOTH scanners, regenerate BOTH fixtures with
 * matching digests, and bump SECRET_SCAN_RULES_VERSION on both sides.
 */

export interface SecretScanFixtureFinding {
  rule: string
  excerpt: string
}

export interface SecretScanFixtureCase {
  /** Human name for the case, used in test output. */
  name: string
  /** One line of candidate pack content. */
  line: string
  /** Findings both scanners must report, in rule evaluation order. */
  findings: SecretScanFixtureFinding[]
}

export const SECRET_SCAN_FIXTURE: SecretScanFixtureCase[] = [
  {
    name: "pgp_private_key",
    line: "-----BEGIN PGP PRIVATE KEY BLOCK-----",
    findings: [{ rule: "private_key_block", excerpt: "----..." }],
  },
  {
    name: "rsa_private_key",
    line: "-----BEGIN RSA PRIVATE KEY-----",
    findings: [{ rule: "private_key_block", excerpt: "----..." }],
  },
  {
    name: "openai_proj_key_with_underscore",
    line: "const k = \"sk-proj-Ab3d_xyz-QQ7t_ZZmn0pQrStUvWxYz12345678\"",
    findings: [{ rule: "openai_api_key", excerpt: "sk-p..." }],
  },
  {
    name: "openai_classic_key",
    line: "const k = \"sk-AbcdefGhijklmnop0123456789\"",
    findings: [{ rule: "openai_api_key", excerpt: "sk-A..." }],
  },
  {
    name: "anthropic_key",
    line: "ANTHROPIC=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA",
    findings: [{ rule: "anthropic_api_key", excerpt: "sk-a..." }],
  },
  {
    name: "aws_access_key",
    line: "AKIAIOSFODNN7EXAMPLE",
    findings: [{ rule: "aws_access_key_id", excerpt: "AKIA..." }],
  },
  {
    name: "aws_secret_no_secret_word",
    line: "aws_key = \"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\"",
    findings: [{ rule: "aws_secret_access_key", excerpt: "wJal..." }],
  },
  {
    name: "aws_secret_with_secret_word",
    line: "aws_secret_access_key = \"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\"",
    findings: [{ rule: "aws_secret_access_key", excerpt: "wJal..." }],
  },
  {
    name: "bearer_tab",
    line: "Authorization:\tBearer\tabcdefghijklmnopqrstuvwxyz012345",
    findings: [{ rule: "bearer_token", excerpt: "abcd..." }],
  },
  {
    name: "bearer_multispace",
    line: "header = \"Bearer   abcdefghijklmnopqrstuvwxyz012345\"",
    findings: [{ rule: "bearer_token", excerpt: "abcd..." }],
  },
  {
    name: "bearer_single_space",
    line: "header = \"Bearer abcdefghijklmnopqrstuvwxyz012345\"",
    findings: [{ rule: "bearer_token", excerpt: "abcd..." }],
  },
  {
    name: "bearer_placeholder",
    line: "header = \"Bearer ${API_TOKEN_VALUE_PLACEHOLDER}\"",
    findings: [],
  },
  {
    name: "conn_string_real",
    line: "DB=postgres://admin:sup3rS3cretPassw0rd@db.host:5432/app",
    findings: [{ rule: "connection_string_password", excerpt: "sup3..." }],
  },
  {
    name: "conn_string_placeholder",
    line: "DB=postgres://admin:${DB_PASSWORD}@db.host:5432/app",
    findings: [],
  },
  {
    name: "placeholder_shadowing",
    line: "api_key: ${YOUR_KEY_HERE_PLACEHOLDER} real_token=AbCdEf0123456789XyZw",
    findings: [{ rule: "generic_secret_assignment", excerpt: "AbCd..." }],
  },
  {
    name: "generic_real",
    line: "password = \"hunter2hunter2hunter2\"",
    findings: [{ rule: "generic_secret_assignment", excerpt: "hunt..." }],
  },
  {
    name: "generic_placeholder",
    line: "password = \"${YOUR_PASSWORD_HERE}\"",
    findings: [],
  },
  {
    name: "github_pat",
    line: "ghp_AbCdEf0123456789AbCdEf0123456789",
    findings: [{ rule: "github_token", excerpt: "ghp_..." }],
  },
  {
    name: "jwt",
    line: "tok=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    findings: [{ rule: "jwt", excerpt: "eyJh..." }],
  },
  {
    name: "slack",
    line: "xoxb-123456789012-abcdefghijkl",
    findings: [{ rule: "slack_token", excerpt: "xoxb..." }],
  },
  {
    name: "stripe",
    line: "sk_live_AbCdEf0123456789",
    findings: [{ rule: "stripe_live_key", excerpt: "sk_l..." }],
  },
  {
    name: "google",
    line: "AIzaSyA1234567890abcdefghijklmnopqrstuvw",
    findings: [{ rule: "google_api_key", excerpt: "AIza..." }],
  },
  {
    name: "clean_prose",
    line: "This agent helps you plan your week and never stores keys.",
    findings: [],
  },
  {
    name: "clean_env_ref",
    line: "Set OPENAI_API_KEY in your environment before first run.",
    findings: [],
  },
]

/** sha256 of JSON.stringify(SECRET_SCAN_FIXTURE). Identical in both repos. */
export const SECRET_SCAN_FIXTURE_DIGEST =
  "e24f2c7d761bd67f1de768f3160769212dfdca06181c5432e4880de1adde2b9b"

/** sha256 of JSON.stringify(rule names, in order). Identical in both repos. */
export const SECRET_SCAN_RULE_NAMES_DIGEST =
  "50e9cbe8ed7c1263c100589d6c794d3d55ff6d80cdd895e2e6d0dbbf1e7a22db"
