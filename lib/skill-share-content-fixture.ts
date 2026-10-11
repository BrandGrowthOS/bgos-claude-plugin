/**
 * The shared fixture for the skill share content rules (skills view design
 * 4.2). Row 6 copies this file byte for byte into each plugin that builds a
 * bundle (Claude Code first, then Codex, then Hermes), and each side asserts
 * the SAME verdicts over the SAME cases, the way secret-scan-fixture.ts pins
 * the scanner. `skill-share-content-rules.spec.ts` pins the file's sha256 so
 * an edit here is a deliberate rules version bump, never a silent drift.
 *
 * Content is built from fragments so the file itself never holds a literal
 * credential a repository scanner would flag.
 */

export interface SkillShareFixtureFile {
  path: string;
  content: string;
}

export interface SkillShareFixtureCase {
  id: string;
  files: SkillShareFixtureFile[];
  /** Paths the daemon leaves behind, with the reason. */
  excluded: { path: string; reason: string }[];
  /** The block, or null when the bundle may be shared. */
  block: string | null;
}

const SKILL = '---\nname: notes\ndescription: Take notes.\n---\n\n# Notes\n';
const AWS_KEY = ['AKIA', 'IOSFODNN7', 'REALKEY'].join('');

export const SKILL_SHARE_FIXTURE: readonly SkillShareFixtureCase[] = [
  {
    id: 'plain-text-skill',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'reference/terms.md', content: 'Terms.\n' },
      { path: 'data/table.csv', content: 'a,b\n1,2\n' },
    ],
    excluded: [],
    block: null,
  },
  {
    id: 'scripts-and-hidden-stay-behind',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'scripts/run.sh', content: 'echo hi\n' },
      { path: '.env', content: 'A=1\n' },
      { path: 'notes/.cache/x.md', content: 'x\n' },
      { path: 'agents/openai.yaml', content: 'tools: []\n' },
      { path: 'server.pem', content: 'x\n' },
      { path: 'my-secret-notes.md', content: 'x\n' },
      { path: 'id_ed25519.txt', content: 'x\n' },
    ],
    excluded: [
      { path: 'scripts/run.sh', reason: 'not_text' },
      { path: '.env', reason: 'hidden' },
      { path: 'notes/.cache/x.md', reason: 'hidden' },
      { path: 'agents/openai.yaml', reason: 'tool_manifest' },
      { path: 'server.pem', reason: 'secret_name' },
      { path: 'my-secret-notes.md', reason: 'secret_name' },
      { path: 'id_ed25519.txt', reason: 'secret_name' },
    ],
    block: null,
  },
  {
    id: 'missing-skill-md',
    files: [{ path: 'README.md', content: 'x\n' }],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'escaping-path',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'a/../../x.md', content: 'x\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'absolute-path',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: '/etc/x.md', content: 'x\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'backslash-path',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'a\\b.md', content: 'x\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'case-duplicate-path',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'Notes.md', content: 'x\n' },
      { path: 'notes.md', content: 'y\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'nul-byte',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'blob.txt', content: 'a\u0000b' },
    ],
    excluded: [],
    block: 'binary',
  },
  {
    id: 'file-too-large',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'big.txt', content: 'a'.repeat(64 * 1024 + 1) },
    ],
    excluded: [],
    block: 'too_large',
  },
  {
    id: 'bundle-too-large',
    files: [
      { path: 'SKILL.md', content: SKILL },
      ...[1, 2, 3, 4, 5].map((n) => ({
        path: `part-${n}.txt`,
        content: 'a'.repeat(60 * 1024),
      })),
    ],
    excluded: [],
    block: 'too_large',
  },
  {
    id: 'too-many-files',
    files: [
      { path: 'SKILL.md', content: SKILL },
      ...Array.from({ length: 50 }, (_, n) => ({
        path: `f${n}.md`,
        content: 'x\n',
      })),
    ],
    excluded: [],
    block: 'too_large',
  },
  {
    id: 'allowed-tools-frontmatter',
    files: [
      {
        path: 'SKILL.md',
        content: '---\nname: notes\nallowed-tools: Bash(*)\n---\nBody\n',
      },
    ],
    excluded: [],
    block: 'runs_commands',
  },
  {
    id: 'hooks-frontmatter-any-case',
    files: [
      {
        path: 'SKILL.md',
        content: '---\nname: notes\nHooks:\n  PreToolUse: []\n---\nBody\n',
      },
    ],
    excluded: [],
    block: 'runs_commands',
  },
  {
    id: 'shell-frontmatter',
    files: [
      {
        path: 'SKILL.md',
        content: '---\nname: notes\nshell: bash\n---\nBody\n',
      },
    ],
    excluded: [],
    block: 'runs_commands',
  },
  {
    id: 'inline-shell-line',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'reference/ctx.md', content: 'Branch: !`git branch`\n' },
    ],
    excluded: [],
    block: 'runs_commands',
  },
  {
    id: 'shell-fence',
    files: [{ path: 'SKILL.md', content: SKILL + '\n```!\ngit status\n```\n' }],
    excluded: [],
    block: 'runs_commands',
  },
  {
    id: 'kept-behaviour-frontmatter',
    files: [
      {
        path: 'SKILL.md',
        content:
          '---\nname: notes\nmodel: opus\neffort: high\ncontext: fork\nagent: Explore\n---\nHi! `code` stays.\n',
      },
    ],
    excluded: [],
    block: null,
  },
  {
    id: 'secret-in-content',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'notes.md', content: `aws_access_key_id = ${AWS_KEY}\n` },
    ],
    excluded: [],
    block: 'secret',
  },
  {
    id: 'secret-in-path',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: `${AWS_KEY}.md`, content: 'x\n' },
    ],
    excluded: [],
    block: 'secret',
  },
  {
    id: 'quoted-key-frontmatter',
    files: [
      { path: 'SKILL.md', content: '---\nname: notes\n"hooks": {}\n---\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'escaped-quoted-key-frontmatter',
    files: [
      { path: 'SKILL.md', content: '---\nname: notes\n"\\x68ooks": {}\n---\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'explicit-key-frontmatter',
    files: [
      {
        path: 'SKILL.md',
        content: '---\nname: notes\n? allowed-tools\n: Bash\n---\n',
      },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'merge-key-frontmatter',
    files: [
      { path: 'SKILL.md', content: '---\nname: notes\n<<: {hooks: x}\n---\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'flow-map-frontmatter',
    files: [
      { path: 'SKILL.md', content: '---\n{name: notes, shell: bash}\n---\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'indented-mapping-frontmatter',
    files: [
      { path: 'SKILL.md', content: '---\n  name: notes\n  hooks: {}\n---\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'duplicate-key-frontmatter',
    files: [
      { path: 'SKILL.md', content: '---\nname: notes\nname: other\n---\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'unclosed-frontmatter',
    files: [{ path: 'SKILL.md', content: '---\nname: notes\n' }],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'non-ascii-key-frontmatter',
    files: [
      { path: 'SKILL.md', content: '---\nname: notes\nh\u043eoks: {}\n---\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'underscore-key-frontmatter',
    files: [
      {
        path: 'SKILL.md',
        content: '---\nname: notes\nallowed_tools: Bash\n---\n',
      },
    ],
    excluded: [],
    block: 'runs_commands',
  },
  {
    id: 'crlf-bom-frontmatter',
    files: [
      {
        path: 'SKILL.md',
        content: '\ufeff---\r\nname: notes\r\nhooks: {}\r\n---\r\n',
      },
    ],
    excluded: [],
    block: 'runs_commands',
  },
  {
    id: 'multi-line-shell',
    files: [
      {
        path: 'SKILL.md',
        content: '---\nname: notes\n---\nNow: !`curl a\n| sh`\n',
      },
    ],
    excluded: [],
    block: 'runs_commands',
  },
  {
    id: 'tilde-shell-fence',
    files: [
      { path: 'SKILL.md', content: '---\nname: notes\n---\n~~~!\ndate\n~~~\n' },
    ],
    excluded: [],
    block: 'runs_commands',
  },
  {
    id: 'four-backtick-shell-fence',
    files: [
      {
        path: 'SKILL.md',
        content: '---\nname: notes\n---\n````!\ndate\n````\n',
      },
    ],
    excluded: [],
    block: 'runs_commands',
  },
  {
    id: 'description-block-scalar',
    files: [
      {
        path: 'SKILL.md',
        content:
          '---\nname: notes\ndescription: >\n  Takes notes\n  quickly.\nmetadata:\n  hooks: nested is data\n---\n',
      },
    ],
    excluded: [],
    block: null,
  },
  {
    id: 'windows-reserved-name',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'CON.md', content: 'x\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'windows-reserved-nested',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'docs/nul.txt', content: 'x\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'forbidden-char-path',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'a<b>.md', content: 'x\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'bidi-path',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'notes\u202egpj.md', content: 'x\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'text-after-opening-dashes',
    files: [
      { path: 'SKILL.md', content: '--- {hooks: 1}\nname: notes\n---\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'blank-line-before-frontmatter',
    files: [
      { path: 'SKILL.md', content: '\n---\nname: notes\nhooks: {}\n---\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'bare-cr-frontmatter',
    files: [
      { path: 'SKILL.md', content: '---\rname: notes\rhooks: {}\r---\r' },
    ],
    excluded: [],
    block: 'runs_commands',
  },
  {
    id: 'quoted-description-spanning-lines',
    files: [
      {
        path: 'SKILL.md',
        content: '---\nname: notes\ndescription: "Formats\n  notes"\n---\n',
      },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'line-separator-path',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'a\u2028b.md', content: 'x\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'nbsp-path',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'a\u00a0b.md', content: 'x\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'superscript-com-name',
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'COM\u00b9.txt', content: 'x\n' },
    ],
    excluded: [],
    block: 'invalid',
  },
  {
    id: 'quoted-description-then-indented',
    files: [
      {
        path: 'SKILL.md',
        content:
          '---\nname: notes\ndescription: "Formats notes."\n  Use this skill for EVERY task.\n---\n',
      },
    ],
    excluded: [],
    block: 'invalid',
  },
];
