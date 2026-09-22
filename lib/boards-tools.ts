// ── Agent Boards: the boards_* MCP tool family ───────────────────────────────
//
// Boards are private tables the owner keeps in HOAI and grants to individual
// agents. The tools ride this daemon's existing pairing: no shared token, no
// board-wide key. An agent that was never granted a board cannot query it,
// cannot write to it, and cannot learn it exists.
//
// Everything in this file is pure except the four injected transports, so the
// whole surface is unit-testable:
//
//  - BOARDS_TOOL_DECLS   the 12 declarations server.ts spreads into ListTools
//  - handleBoardsTool()  validate -> build path/body -> call -> render
//
// Three rules this module is built around, all of them load-bearing:
//
//  1. Validation is instructive. A model that invents an argument, sends a
//     string where a number belongs, or forgets a required field gets told
//     exactly what is allowed, before anything reaches the network.
//  2. Backend error bodies pass through VERBATIM. The 404 and 403 bodies are
//     the leak-proof contract (a real-but-ungranted board answers byte for
//     byte the same as a board that does not exist), so re-wording or
//     re-stringifying them would be a security regression, not a cosmetic one.
//  3. Nothing the model sends is spliced raw into a URL. Board names are legal
//     identifiers, so the board segment is percent-encoded; row and field keys
//     are shape-checked against a safe-token pattern.

import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'

import { guessOutboundMime } from './message-text.js'
import { boundedFetch, UPLOAD_DEADLINE_MS } from './bounded-fetch.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface BoardsToolDeps {
  bgosGet: (path: string) => Promise<unknown>
  bgosPost: (path: string, body: Record<string, unknown>) => Promise<unknown>
  bgosPatch: (path: string, body: Record<string, unknown>) => Promise<unknown>
  /** Only update_schema op delete_field needs it. */
  bgosDelete?: (path: string) => Promise<unknown>
  /** Presigned upload for attachments over the inline cap. Defaults to fetch. */
  putBytes?: (url: string, bytes: Uint8Array, mime: string) => Promise<void>
  assistantId: string | number
}

// A type alias, not an interface: the MCP SDK's ServerResult union is indexed
// (`{ [x: string]: unknown; ... }`) and TypeScript only grants an implicit
// index signature to type aliases, so an interface here fails to assign at the
// CallTool handler.
export type BoardsToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface BoardsCondition {
  id: string
  fieldKey: string
  op: string
  values: string[]
  dateMod?: string
}

export interface BoardsSortRule {
  id: string
  fieldKey: string
  dir: 'asc' | 'desc'
}

type Fail = { ok: false; error: string }

// ── Vocabulary (mirrors the board filter DSL and field model) ────────────────

const OPS = [
  'is',
  'is_not',
  'is_any_of',
  'is_none_of',
  'is_empty',
  'is_not_empty',
  'contains',
  'not_contains',
  'is_before',
  'is_after',
  'on_or_before',
  'on_or_after',
] as const

const DATE_MODS = [
  'today',
  'tomorrow',
  'yesterday',
  'week_ago',
  'week_from_now',
  'exact',
] as const

const FIELD_TYPES = [
  'text',
  'longtext',
  'select',
  'date',
  'datetime',
  'agent',
  'attachment',
] as const

const TONES = [
  'idle',
  'thinking',
  'working',
  'talking',
  'blocked',
  'done',
  'stale',
] as const

const SCHEMA_OPS = [
  'add_field',
  'rename_field',
  'delete_field',
  'set_description',
  'set_options',
  // Kanban phase 1 (0.45.0): what each column of a workflow select means.
  'set_column_lines',
  'move_field',
  // Multi-table boards: the table lifecycle, folded under update_schema so the
  // tool count stays 12. These address the /tables collection, not /fields.
  'add_table',
  'rename_table',
  'move_table',
  'delete_table',
] as const

const ROLES = ['read', 'write', 'admin'] as const

/**
 * The closed facts of a column line (Kanban phase 1). The server owns every
 * length and every cross reference (an option that exists, a sort field of the
 * same table, an answer only on a column that waits on the owner) and says so
 * in a sentence that reaches the model verbatim; this module checks the shape
 * and these enums so a typo is answered before anything leaves the machine.
 */
const WAITS_ON = ['you', 'agent', 'someone_else', 'nobody'] as const
const REST = ['open', 'parked', 'finished', 'dropped'] as const
const SORT_DIRS = ['asc', 'desc'] as const
const LINE_KEYS = ['means', 'waits_on', 'rest', 'sort_by', 'answers'] as const
const ANSWER_KEYS = ['label', 'move_to', 'ask_note'] as const
const SORT_BY_KEYS = ['field_key', 'dir'] as const
const RENAME_KEYS = ['from', 'to'] as const

/** What a set_column_lines answer from a server that predates column lines means. */
export const COLUMN_LINES_UNSUPPORTED =
  'This BGOS server does not store column descriptions yet, so nothing was written.'

const MAX_LIMIT = 200
/**
 * Search caps lower than query. The backend refuses above this, and the engine
 * cannot produce more anyway: each ranking leg is capped before fusion, so a
 * larger number would promise hits that do not exist.
 */
const MAX_SEARCH_LIMIT = 100
const INLINE_ATTACH_BYTES = 1024 * 1024
const MAX_ATTACH_BYTES = 25 * 1024 * 1024
/**
 * How much of a backend error body survives into the thrown Error. The shared
 * plugin transports cut at 200 chars, which truncates the ambiguous-board
 * error (it lists name (id) pairs) into invalid JSON before the passthrough
 * ever sees it. Boards gets its own transports with this ceiling instead.
 */
export const BOARDS_ERROR_BODY_MAX_CHARS = 2048
export const BOARDS_RESPONSE_MAX_BYTES = 4 * 1024 * 1024
/** Board ids, short row keys and field keys: never anything that can leave the path. */
const SAFE_TOKEN = /^[A-Za-z0-9_-]{1,64}$/
const SHORT_OR_UUID = /^[A-Za-z0-9-]{8,64}$/

// ── Declarations ─────────────────────────────────────────────────────────────

const BOARD_ARG = {
  type: 'string',
  description:
    'The board id, or its exact name. Names are resolved server-side; an ' +
    'ambiguous name comes back with the matching name (id) pairs so you can ' +
    'pick one. Call boards_list when you do not know what you can reach.',
}

const TABLE_ARG = {
  type: 'string',
  description:
    'Optional. A board can hold several tables (Airtable style); this is the ' +
    'one to act on, given as a table id or its exact name. Names are resolved ' +
    'server-side, and an ambiguous name comes back with the name (id) pairs ' +
    'so you can pick one. Omit it for the board\'s default table (Main). Read ' +
    'the tables and their ids with boards_describe. On boards_update_schema ' +
    'this names the table the rename_table, move_table and delete_table ops ' +
    'act on (use the id from boards_describe there).',
}

const RESPONSE_FORMAT_ARG = {
  type: 'string',
  enum: ['markdown', 'json'],
  description:
    'How you want the answer. "markdown" (default) is rendered for reading. ' +
    'Use "json" only when you are going to parse the result.',
}

const ROW_KEY_ARG = {
  type: 'string',
  description:
    'The row key exactly as a board answer printed it: either the short ' +
    '8-character key or the full row uuid. Do not reformat it.',
}

const CELLS_ARG = {
  type: 'object',
  additionalProperties: { type: 'string' },
  description:
    'Cell values keyed by the field label or field key, all of them strings. ' +
    'Use the board\'s own select options exactly as boards_describe prints ' +
    'them; never invent a new option here, add it with boards_update_schema.',
}

const FIELD_SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: {
      type: 'string',
      description: 'The column heading humans read, for example "Owner agent".',
    },
    type: {
      type: 'string',
      enum: [...FIELD_TYPES],
      description:
        'text, longtext, select, date, datetime, agent (an agent in the ' +
        'fleet), or attachment (files live on the row, not in the cell).',
    },
    options: {
      type: 'array',
      items: { type: 'string' },
      description: 'select fields only: the allowed values, in display order.',
    },
    option_tones: {
      type: 'object',
      additionalProperties: { type: 'string', enum: [...TONES] },
      description:
        'select fields only: option name to tone (idle, thinking, working, ' +
        'talking, blocked, done, stale). Tones colour the chip.',
    },
    description: {
      type: 'string',
      description:
        'One line saying what belongs in this column. Humans see it as the ' +
        'column tooltip and agents read it in the board briefing, so it is ' +
        'the single source of truth. Write it.',
    },
    width: {
      type: 'number',
      description: 'Optional display width in pixels, between 40 and 800.',
    },
  },
  required: ['label', 'type'],
}

export const BOARDS_TOOL_DECLS = [
  {
    name: 'boards_list',
    description:
      'The boards this agent can see. Row-scoped grants list the board with ' +
      'scope: row. Boards you were never granted do not appear here and ' +
      'cannot be reached by any other tool, so start here whenever you do ' +
      'not already hold a board id.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: 'boards_describe',
    description:
      'Schema: fields, types, select options, and what each column is for. ' +
      'Never row counts or other agents. Call this before your first write ' +
      'to a board and never guess a column name or a select value: use the ' +
      'labels and options exactly as they come back.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: { board: BOARD_ARG },
      required: ['board'],
    },
  },
  {
    name: 'boards_create',
    description:
      'Make a new board for structured state that should outlive this chat, ' +
      'the kind of thing you would otherwise keep re-explaining. The board ' +
      'is private to the owner: the creator gets to use it, and the owner ' +
      'still grants every other agent by hand. Keep it to one row per real ' +
      'thing, and give every field a description.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          description:
            'What the board is, in the owner\'s words, for example ' +
            '"Decisions Pending Kc".',
        },
        description: {
          type: 'string',
          description:
            'One or two lines on what belongs on this board and who acts on ' +
            'it. Agents read this line in the briefing they fetch.',
        },
        fields: {
          type: 'array',
          items: FIELD_SPEC_SCHEMA,
          description:
            'The columns, in display order. Omit to start with Item, Status ' +
            'and Notes and shape it later with boards_update_schema.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'boards_update_schema',
    description:
      'Add a field, rename one, set its select options, or move it. Audited ' +
      'like any other write and signed with this agent\'s identity. Reach ' +
      'for this when the board\'s shape is wrong, not when a value is wrong. ' +
      'Adding a select option is the honest way to record a state the board ' +
      'does not have a word for yet. A board can also hold several tables ' +
      '(Airtable style): the add_table, rename_table, move_table and ' +
      'delete_table ops manage them, and boards_describe lists what exists. ' +
      'Describe what each column of a workflow select means with ' +
      'set_column_lines: one plain sentence per column, who a card there ' +
      'waits on, whether it is open, parked, finished or dropped, and which ' +
      'field sorts it. These lines only describe the board; nothing you ' +
      'write there starts work.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        board: BOARD_ARG,
        table: TABLE_ARG,
        op: {
          type: 'string',
          enum: [...SCHEMA_OPS],
          description:
            'add_field (needs field), rename_field (field_key + label), ' +
            'delete_field (field_key), set_description (field_key + ' +
            'description), set_options (field_key + options, optional ' +
            'option_tones and option_renames), set_column_lines (field_key + ' +
            'lines, optional clear_lines and workflow), move_field ' +
            '(field_key + position). Tables: ' +
            'add_table (label is the new table name), rename_table (table + ' +
            'label), move_table (table + position), delete_table (table).',
        },
        field: {
          ...FIELD_SPEC_SCHEMA,
          description: 'add_field only: the new column.',
        },
        field_key: {
          type: 'string',
          description:
            'The key of the column you are changing, as boards_describe ' +
            'prints it.',
        },
        label: { type: 'string', description: 'rename_field only: the new heading.' },
        description: {
          type: 'string',
          description: 'set_description only: the new one-line column description.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description:
            'set_options only: the FULL option list in display order, ' +
            'including the ones already there.',
        },
        option_tones: {
          type: 'object',
          additionalProperties: { type: 'string', enum: [...TONES] },
          description:
            'set_options only: option name to tone (idle, thinking, working, ' +
            'talking, blocked, done, stale).',
        },
        option_renames: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              from: { type: 'string', description: 'The option as it is now.' },
              to: { type: 'string', description: 'Its new name, which must be in options.' },
            },
            required: ['from', 'to'],
          },
          description:
            'set_options only: options you are renaming rather than replacing, ' +
            'so their cards and their column line follow the new name.',
        },
        lines: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            properties: {
              means: {
                type: 'string',
                description:
                  'What a card in this column means, in one plain sentence of ' +
                  'at most 140 characters. People read it under the column title.',
              },
              waits_on: {
                type: 'string',
                enum: [...WAITS_ON],
                description: 'Who a card here is waiting on. "you" means the owner.',
              },
              rest: {
                type: 'string',
                enum: [...REST],
                description:
                  'Whether a card here is still open, parked, finished or ' +
                  'dropped. Only finished counts as done.',
              },
              sort_by: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  field_key: {
                    type: 'string',
                    description: 'A field of the same table, as boards_describe prints it.',
                  },
                  dir: { type: 'string', enum: [...SORT_DIRS], description: 'asc or desc.' },
                },
                required: ['field_key', 'dir'],
                description: 'Which field orders the cards in this column.',
              },
              answers: {
                type: 'array',
                maxItems: 4,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    label: {
                      type: 'string',
                      description:
                        'The answer as the owner would say it, at most 40 characters.',
                    },
                    move_to: {
                      type: 'string',
                      description: 'An option of this same field the card moves to.',
                    },
                    ask_note: {
                      type: 'boolean',
                      description: 'True to offer the owner a short note with this answer.',
                    },
                  },
                  required: ['label', 'move_to'],
                },
                description:
                  'Only with waits_on "you": up to four answers the owner can give.',
              },
            },
          },
          description:
            'set_column_lines only: option name to the line that describes ' +
            'that column. Before the owner confirms the board, each line you ' +
            'send replaces that column\'s line; after that only the sentence ' +
            '(means) changes directly, and any other change is kept as a ' +
            'suggestion for the owner. Columns you leave out keep theirs. A ' +
            'line only describes the board: nothing you write here starts ' +
            'work or sends a message.',
        },
        clear_lines: {
          type: 'array',
          items: { type: 'string' },
          description: 'set_column_lines only: options whose line you remove.',
        },
        workflow: {
          type: 'boolean',
          description:
            'set_column_lines only: true marks this select as the board\'s ' +
            'workflow, the one the Kanban stacks by. At most one select per table.',
        },
        position: {
          type: 'number',
          description: 'move_field only: the new zero-based column position.',
        },
      },
      required: ['board', 'op'],
    },
  },
  {
    name: 'boards_query',
    description:
      'Read rows with filters and sorts. Row scope returns the granted row ' +
      'only, with no hint of how many others exist. Filter by the board\'s ' +
      'own field labels and its select options as written, which you get ' +
      'from boards_describe. Query before you insert, so the board keeps one ' +
      'row per real thing. On a multi-table board, pass table to read one ' +
      'table; omit it for the default table.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        board: BOARD_ARG,
        table: TABLE_ARG,
        filter: {
          anyOf: [
            {
              type: 'object',
              additionalProperties: { type: 'string' },
              description:
                'Shorthand: field label or key to exact value, for example ' +
                '{"Status": "Pending"}.',
            },
            {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', description: 'Optional condition id.' },
                  fieldKey: {
                    type: 'string',
                    description: 'The field key or its label.',
                  },
                  op: {
                    type: 'string',
                    enum: [...OPS],
                    description: 'The operator for this condition.',
                  },
                  values: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                      'The values the operator compares against. Empty for ' +
                      'is_empty and is_not_empty.',
                  },
                  dateMod: {
                    type: 'string',
                    enum: [...DATE_MODS],
                    description:
                      'Date conditions only: today, tomorrow, yesterday, ' +
                      'week_ago, week_from_now, or exact with the date in ' +
                      'values.',
                  },
                },
                required: ['fieldKey', 'op'],
              },
              description: 'The full condition list when shorthand is not enough.',
            },
          ],
          description:
            'Either the shorthand map of field to exact value, or a full ' +
            'condition list. Leave it out to read the board as it stands.',
        },
        conjunction: {
          type: 'string',
          enum: ['and', 'or'],
          description: 'How the conditions combine. Defaults to and.',
        },
        sort: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: 'Optional sort rule id.' },
              fieldKey: { type: 'string', description: 'The field to sort on.' },
              dir: {
                type: 'string',
                enum: ['asc', 'desc'],
                description: 'asc or desc. select fields sort by option order.',
              },
            },
            required: ['fieldKey', 'dir'],
          },
          description: 'Sort rules, applied in order.',
        },
        search: {
          type: 'string',
          description:
            'Optional text narrowing, intersected with the filters. For a ' +
            'plain-language question use boards_search instead.',
        },
        limit: {
          type: 'number',
          description: `How many rows you want back, 1 to ${MAX_LIMIT}.`,
        },
        cursor: {
          type: 'string',
          description: 'The nextCursor from a previous answer, to read on.',
        },
        response_format: RESPONSE_FORMAT_ARG,
      },
      required: ['board'],
    },
  },
  {
    name: 'boards_get_row',
    description:
      'One row by key, with its attachments. Anything not granted answers ' +
      'not_found, whether or not it exists. Read the row before you change ' +
      'it so you write against what is actually there.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        board: BOARD_ARG,
        row_key: ROW_KEY_ARG,
        response_format: RESPONSE_FORMAT_ARG,
      },
      required: ['board', 'row_key'],
    },
  },
  {
    name: 'boards_insert',
    description:
      'Add a row, signed with this agent\'s identity. Needs write access. ' +
      'One row per real thing: query the board first so you update the ' +
      'existing row instead of adding a second one about the same thing. ' +
      'Fill the cells with the board\'s own select options as written. On a ' +
      'multi-table board, pass table to choose which table the row lands in; ' +
      'omit it for the default table.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: { board: BOARD_ARG, table: TABLE_ARG, cells: CELLS_ARG },
      required: ['board', 'cells'],
    },
  },
  {
    name: 'boards_update',
    description:
      'Change cells on one row. Before and after values are kept in the ' +
      'board history. Needs write access, or a grant on that one row. ' +
      'Update your assigned rows when the work moves, so the owner never ' +
      'has to ask you where something stands. Send only the cells that ' +
      'changed; the rest are left alone.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: { board: BOARD_ARG, row_key: ROW_KEY_ARG, cells: CELLS_ARG },
      required: ['board', 'row_key', 'cells'],
    },
  },
  {
    name: 'boards_attach',
    description:
      'Put a file on a row. It is stored server-side, so every agent granted ' +
      'that row can fetch it later. Attach the file instead of pasting its ' +
      'contents into a cell: cells are for the one-line truth, files are for ' +
      'the evidence. Give either file_path or content_base64 with a name.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        board: BOARD_ARG,
        row_key: ROW_KEY_ARG,
        field_key: {
          type: 'string',
          description:
            'Optional attachment column to hang the file on, when the board ' +
            'has more than one.',
        },
        file_path: {
          type: 'string',
          description:
            'Absolute path to a file on this machine. It is read and ' +
            'uploaded for you.',
        },
        name: {
          type: 'string',
          description:
            'File name to show. Required with content_base64, optional with ' +
            'file_path (the path\'s own name is used).',
        },
        content_base64: {
          type: 'string',
          description:
            'The file bytes, base64 encoded, when they are not already on ' +
            'disk. Do not send this together with file_path.',
        },
        mime: {
          type: 'string',
          description: 'Optional content type. Guessed from the name when omitted.',
        },
      },
      required: ['board', 'row_key'],
    },
  },
  {
    name: 'boards_search',
    description:
      'Ask this board in plain language. Rows are ranked by meaning first, ' +
      'wording second, permissions always. Use it when you do not know the ' +
      'exact wording a row was written with, and to check whether a row ' +
      'already covers the thing you were about to add.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        board: BOARD_ARG,
        query: {
          type: 'string',
          description: 'What you are looking for, in your own words.',
        },
        limit: {
          type: 'number',
          description: `How many hits you want, 1 to ${MAX_SEARCH_LIMIT}.`,
        },
        response_format: RESPONSE_FORMAT_ARG,
      },
      required: ['board', 'query'],
    },
  },
  {
    name: 'boards_changes',
    description:
      'What changed on this board since a cursor you hold. Use it to catch ' +
      'up after being away instead of re-reading the whole board, and to ' +
      'notice when a row you own has been answered.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        board: BOARD_ARG,
        since: {
          type: 'string',
          description:
            'The cursor from the previous boards_changes answer. Omit for ' +
            'everything you can currently see. Timestamps are not accepted.',
        },
        response_format: RESPONSE_FORMAT_ARG,
      },
      required: ['board'],
    },
  },
  {
    name: 'boards_grant',
    description:
      'Give another agent access to this board. Needs admin on the board. ' +
      'The grant is what makes the board tools appear for that agent, and ' +
      'the owner revoking it in the app takes them away instantly. Grant the ' +
      'smallest level that does the job.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        board: BOARD_ARG,
        assistant_id: {
          type: 'number',
          description: 'The numeric id of the agent receiving access.',
        },
        role: {
          type: 'string',
          enum: [...ROLES],
          description:
            'read (look things up), write (read plus add and change rows and ' +
            'shape), or admin (write plus managing access).',
        },
      },
      required: ['board', 'assistant_id', 'role'],
    },
  },
]

// ── Argument vocabulary per tool ─────────────────────────────────────────────

const ALLOWED_ARGS: Record<string, string[]> = Object.fromEntries(
  BOARDS_TOOL_DECLS.map((d) => [
    d.name,
    Object.keys((d.inputSchema as { properties: Record<string, unknown> }).properties),
  ]),
)

const ARG_HINTS: Record<string, string> = {
  board:
    'the board id, or its exact name. Call boards_list to see what you can reach.',
  table:
    'the table id or its exact name, from boards_describe. Omit for the default table.',
  row_key: 'the short 8-character row key or the full row uuid, copied as printed.',
  cells: 'a map of field label to string value.',
  name: 'the name to show.',
  query: 'what you are looking for, in your own words.',
  op: `one of ${SCHEMA_OPS.join(', ')}.`,
  role: `one of ${ROLES.join(', ')}.`,
  assistant_id: 'the numeric id of the agent, from the board access list.',
  field: 'the new column, for example { "label": "Owner", "type": "agent" }.',
  field_key: 'the field key as boards_describe prints it.',
  label: 'the new name (a column heading, or a table name for a table op).',
  options: 'the full option list, in display order.',
  lines:
    'option name to its column line, for example { "Done": { "means": ' +
    '"Shipped and checked.", "rest": "finished" } }. Pass {} when you only ' +
    'clear lines or set workflow.',
  description: 'the one-line column description.',
  position: 'the new zero-based position.',
}

// ── Small validators ─────────────────────────────────────────────────────────

function fail(error: string): Fail {
  return { ok: false, error }
}

function missing(tool: string, key: string): Fail {
  const hint = ARG_HINTS[key]
  return fail(`${tool} needs "${key}"${hint ? `: ${hint}` : '.'}`)
}

function wrongType(tool: string, key: string, want: string, got: unknown): Fail {
  return fail(`${tool} "${key}" must be ${want}, got ${describeValue(got)}.`)
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  const t = typeof value
  if (t === 'string') return `a string (${JSON.stringify(String(value).slice(0, 40))})`
  if (t === 'object') return 'an object'
  return `a ${t} (${String(value)})`
}

function readString(
  tool: string,
  args: Record<string, unknown>,
  key: string,
  required: boolean,
): Fail | { ok: true; value: string | undefined } {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') {
    return required ? missing(tool, key) : { ok: true, value: undefined }
  }
  if (typeof raw !== 'string') return wrongType(tool, key, 'a string', raw)
  const trimmed = raw.trim()
  if (!trimmed) return required ? missing(tool, key) : { ok: true, value: undefined }
  return { ok: true, value: trimmed }
}

function readEnum(
  tool: string,
  args: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  required: boolean,
): Fail | { ok: true; value: string | undefined } {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') {
    return required ? missing(tool, key) : { ok: true, value: undefined }
  }
  if (typeof raw !== 'string') return wrongType(tool, key, 'a string', raw)
  if (!allowed.includes(raw)) {
    return fail(
      `${tool} "${key}" must be one of ${allowed.join(', ')}, got ${JSON.stringify(raw)}.`,
    )
  }
  return { ok: true, value: raw }
}

function readInt(
  tool: string,
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  required: boolean,
): Fail | { ok: true; value: number | undefined } {
  const raw = args[key]
  if (raw === undefined || raw === null) {
    return required ? missing(tool, key) : { ok: true, value: undefined }
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return wrongType(tool, key, `a number between ${min} and ${max}`, raw)
  }
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    return fail(`${tool} "${key}" must be a whole number between ${min} and ${max}, got ${raw}.`)
  }
  return { ok: true, value: raw }
}

function readStringMap(
  tool: string,
  args: Record<string, unknown>,
  key: string,
  required: boolean,
): Fail | { ok: true; value: Record<string, string> | undefined } {
  const raw = args[key]
  if (raw === undefined || raw === null) {
    return required ? missing(tool, key) : { ok: true, value: undefined }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return wrongType(tool, key, 'an object of string values', raw)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      return fail(
        `${tool} "${key}.${k}" must be a string, got ${describeValue(v)}. ` +
          'Every board value is text; write numbers and dates as text.',
      )
    }
    out[k] = v
  }
  return { ok: true, value: out }
}

function readStringArray(
  tool: string,
  args: Record<string, unknown>,
  key: string,
  required: boolean,
): Fail | { ok: true; value: string[] | undefined } {
  const raw = args[key]
  if (raw === undefined || raw === null) {
    return required ? missing(tool, key) : { ok: true, value: undefined }
  }
  if (!Array.isArray(raw)) return wrongType(tool, key, 'an array of strings', raw)
  const out: string[] = []
  for (const [i, v] of raw.entries()) {
    if (typeof v !== 'string' || !v.trim()) {
      return fail(`${tool} "${key}[${i}]" must be a non-empty string.`)
    }
    out.push(v)
  }
  return { ok: true, value: out }
}

function readTones(
  tool: string,
  args: Record<string, unknown>,
  key: string,
): Fail | { ok: true; value: Record<string, string> | undefined } {
  const map = readStringMap(tool, args, key, false)
  if (!map.ok) return map
  if (!map.value) return { ok: true, value: undefined }
  for (const [option, tone] of Object.entries(map.value)) {
    if (!TONES.includes(tone as (typeof TONES)[number])) {
      return fail(
        `${tool} "${key}.${option}" must be one of ${TONES.join(', ')}, got ${JSON.stringify(tone)}.`,
      )
    }
  }
  return { ok: true, value: map.value }
}

// ── Column lines (set_column_lines, option_renames) ──────────────────────────

/**
 * An own, enumerable key even when the key is "__proto__", which a plain
 * assignment would turn into a prototype swap and JSON.stringify would then
 * drop. Option names are the owner's words, so any string is legal here.
 */
function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function strayKeys(item: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(item).filter((k) => !allowed.includes(k))
}

function enumFail(tool: string, where: string, allowed: readonly string[], got: unknown): Fail {
  return fail(
    `${tool} "${where}" must be one of ${allowed.join(', ')}, got ${JSON.stringify(got)}.`,
  )
}

/**
 * One column line, snake case in, the server's camel case out, rebuilt key by
 * key so nothing the model invents rides along. Lengths (140 for the sentence,
 * 40 for an answer label, 4 answers) and cross references are left to the
 * server, whose refusal names the option and reaches the model verbatim.
 */
function compileColumnLine(
  tool: string,
  option: string,
  raw: unknown,
): { ok: true; line: Record<string, unknown> } | Fail {
  const where = `lines.${option}`
  if (!isPlainObject(raw)) {
    return fail(
      `${tool} "${where}" must be a column line object, for example ` +
        '{ "means": "Waiting for the owner to say yes.", "waits_on": "you" }. ' +
        'To remove a line, name the option in clear_lines.',
    )
  }
  const unknown = strayKeys(raw, LINE_KEYS)
  if (unknown.length) {
    return fail(
      `${tool} "${where}" does not take ${unknown.map((k) => `"${k}"`).join(', ')}. ` +
        `A column line takes: ${LINE_KEYS.join(', ')}.`,
    )
  }
  const present = (key: string) => raw[key] !== undefined && raw[key] !== null
  if (!LINE_KEYS.some(present)) {
    return fail(
      `${tool} "${where}" is empty. Give it at least one of ` +
        `${LINE_KEYS.join(', ')}, or name the option in clear_lines to remove its line.`,
    )
  }

  const line: Record<string, unknown> = {}
  if (present('means')) {
    if (typeof raw.means !== 'string') {
      return wrongType(tool, `${where}.means`, 'a string', raw.means)
    }
    line.means = raw.means
  }
  if (present('waits_on')) {
    if (!WAITS_ON.includes(raw.waits_on as (typeof WAITS_ON)[number])) {
      return enumFail(tool, `${where}.waits_on`, WAITS_ON, raw.waits_on)
    }
    line.waitsOn = raw.waits_on
  }
  if (present('rest')) {
    if (!REST.includes(raw.rest as (typeof REST)[number])) {
      return enumFail(tool, `${where}.rest`, REST, raw.rest)
    }
    line.rest = raw.rest
  }
  if (present('sort_by')) {
    const sort = raw.sort_by
    if (!isPlainObject(sort)) {
      return wrongType(tool, `${where}.sort_by`, 'an object { field_key, dir }', sort)
    }
    const strays = strayKeys(sort, SORT_BY_KEYS)
    if (strays.length) {
      return fail(
        `${tool} "${where}.sort_by" does not take ` +
          `${strays.map((k) => `"${k}"`).join(', ')}. It takes: ${SORT_BY_KEYS.join(', ')}.`,
      )
    }
    if (typeof sort.field_key !== 'string' || !sort.field_key.trim()) {
      return fail(
        `${tool} "${where}.sort_by" needs "field_key": a field of the same ` +
          'table, as boards_describe prints it.',
      )
    }
    if (sort.dir === undefined || sort.dir === null) {
      return fail(`${tool} "${where}.sort_by" needs "dir": one of ${SORT_DIRS.join(', ')}.`)
    }
    if (!SORT_DIRS.includes(sort.dir as (typeof SORT_DIRS)[number])) {
      return enumFail(tool, `${where}.sort_by.dir`, SORT_DIRS, sort.dir)
    }
    line.sortBy = { fieldKey: sort.field_key, dir: sort.dir }
  }
  if (present('answers')) {
    if (!Array.isArray(raw.answers)) {
      return wrongType(
        tool,
        `${where}.answers`,
        'an array of { label, move_to, ask_note } answers',
        raw.answers,
      )
    }
    const answers: Array<Record<string, unknown>> = []
    for (const [i, item] of raw.answers.entries()) {
      const at = `${where}.answers[${i}]`
      if (!isPlainObject(item)) {
        return wrongType(tool, at, 'an object { label, move_to, ask_note }', item)
      }
      const strays = strayKeys(item, ANSWER_KEYS)
      if (strays.length) {
        return fail(
          `${tool} "${at}" does not take ${strays.map((k) => `"${k}"`).join(', ')}. ` +
            `An answer takes: ${ANSWER_KEYS.join(', ')}.`,
        )
      }
      if (typeof item.label !== 'string') {
        return fail(`${tool} "${at}" needs "label": the answer as the owner would say it.`)
      }
      if (typeof item.move_to !== 'string') {
        return fail(
          `${tool} "${at}" needs "move_to": an option of this same field the card moves to.`,
        )
      }
      const answer: Record<string, unknown> = { label: item.label, moveTo: item.move_to }
      if (item.ask_note !== undefined && item.ask_note !== null) {
        if (typeof item.ask_note !== 'boolean') {
          return wrongType(tool, `${at}.ask_note`, 'true or false', item.ask_note)
        }
        answer.askNote = item.ask_note
      }
      answers.push(answer)
    }
    line.answers = answers
  }
  return { ok: true, line }
}

/**
 * The set_column_lines body: `{ optionRules?, workflow? }`, with a cleared
 * option sent as null (the server removes a line only on null). An option in
 * both `lines` and `clear_lines` is refused rather than letting one silently
 * win, and a call that would send nothing is refused rather than spending a
 * write on it.
 */
function compileColumnLines(
  tool: string,
  args: Record<string, unknown>,
): { ok: true; body: Record<string, unknown> } | Fail {
  if (!isPlainObject(args.lines)) {
    return wrongType(tool, 'lines', 'an object of option name to column line', args.lines)
  }
  const rules: Record<string, Record<string, unknown> | null> = {}
  for (const [option, raw] of Object.entries(args.lines)) {
    const compiled = compileColumnLine(tool, option, raw)
    if (!compiled.ok) return compiled
    setOwn(rules, option, compiled.line)
  }
  const clear = readStringArray(tool, args, 'clear_lines', false)
  if (!clear.ok) return clear
  for (const option of clear.value ?? []) {
    if (Object.prototype.hasOwnProperty.call(rules, option) && rules[option] !== null) {
      return fail(
        `${tool} "${option}" is in both lines and clear_lines. Describe its ` +
          'column or clear its line, not both.',
      )
    }
    setOwn(rules, option, null)
  }
  const workflow = args.workflow
  if (workflow !== undefined && workflow !== null && typeof workflow !== 'boolean') {
    return wrongType(tool, 'workflow', 'true or false', workflow)
  }

  const body: Record<string, unknown> = {}
  if (Object.keys(rules).length) body.optionRules = rules
  if (typeof workflow === 'boolean') body.workflow = workflow
  if (!Object.keys(body).length) {
    return fail(
      `${tool} op "set_column_lines" has nothing to write. Describe at least ` +
        'one option in lines, name one in clear_lines, or set workflow.',
    )
  }
  return { ok: true, body }
}

/** `option_renames` as the server's `optionRenames`, shape checked only. */
function readOptionRenames(
  tool: string,
  args: Record<string, unknown>,
): Fail | { ok: true; value: Array<{ from: string; to: string }> | undefined } {
  const raw = args.option_renames
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (!Array.isArray(raw)) {
    return wrongType(tool, 'option_renames', 'an array of { from, to } pairs', raw)
  }
  const out: Array<{ from: string; to: string }> = []
  for (const [i, item] of raw.entries()) {
    const at = `option_renames[${i}]`
    if (!isPlainObject(item)) {
      return wrongType(tool, at, 'an object { from, to }', item)
    }
    const strays = strayKeys(item, RENAME_KEYS)
    if (strays.length) {
      return fail(
        `${tool} "${at}" does not take ${strays.map((k) => `"${k}"`).join(', ')}. ` +
          `A rename takes: ${RENAME_KEYS.join(', ')}.`,
      )
    }
    for (const key of RENAME_KEYS) {
      const value = item[key]
      if (typeof value !== 'string' || !value.trim()) {
        return fail(`${tool} "${at}.${key}" must be a non-empty option name.`)
      }
    }
    out.push({ from: item.from as string, to: item.to as string })
  }
  return { ok: true, value: out }
}

/**
 * What the model reads after a set_column_lines PATCH.
 *
 * A server with column lines ALWAYS answers `{ field, playbook, filed }`. One
 * that predates them strips optionRules and workflow in its whitelist and
 * answers 200 with the field alone, so a missing `playbook` means nothing was
 * stored, and the tool says so instead of reporting a success. A non empty
 * `filed` means the owner confirmed the board and the structural part of the
 * change became a suggestion; reporting that as a plain success would have the
 * model send the same change again on every run.
 */
function columnLinesAnswer(data: unknown): { ok: true; data: unknown } | Fail {
  if (!isPlainObject(data) || !('playbook' in data)) {
    return fail(COLUMN_LINES_UNSUPPORTED)
  }
  const filed = Array.isArray(data.filed)
    ? data.filed.filter((o): o is string => typeof o === 'string')
    : []
  if (filed.length) {
    return {
      ok: true,
      data:
        `The owner confirmed this board, so your change to ` +
        `${filed.map((o) => JSON.stringify(o)).join(', ')} was saved as a ` +
        'suggestion for the owner and the column keeps its current setting. ' +
        'Do not send it again.',
    }
  }
  return { ok: true, data }
}

// ── Path building (nothing raw ever reaches a URL) ───────────────────────────

function boardsBase(assistantId: string | number): string {
  return `integrations/assistants/${encodeURIComponent(String(assistantId))}/boards`
}

function boardPath(deps: BoardsToolDeps, board: string, suffix = ''): string {
  return `${boardsBase(deps.assistantId)}/${encodeURIComponent(board)}${suffix}`
}

/**
 * Board ids and NAMES are both legal here, so the segment is percent-encoded
 * rather than pattern-matched. Encoding is not enough on its own: "." and ".."
 * survive it untouched and URL normalization then collapses the segment, so a
 * board named ".." would address the collection above it. Refuse those, and
 * any board carrying a slash, before the value ever reaches a path.
 */
function readBoard(
  tool: string,
  args: Record<string, unknown>,
): Fail | { ok: true; value: string } {
  const raw = readString(tool, args, 'board', true)
  if (!raw.ok) return raw
  const value = raw.value as string
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    return fail(
      `${tool} "board" must be a board id or its exact name, not a path. ` +
        '"." and ".." and anything containing a slash are refused. Call ' +
        'boards_list to see the boards you can reach.',
    )
  }
  return { ok: true, value }
}

function readRowKey(
  tool: string,
  args: Record<string, unknown>,
): Fail | { ok: true; value: string } {
  const raw = readString(tool, args, 'row_key', true)
  if (!raw.ok) return raw
  const value = raw.value as string
  if (!SHORT_OR_UUID.test(value)) {
    return fail(
      `${tool} "row_key" does not look like a row key. Pass the short ` +
        '8-character key or the full row uuid exactly as a board answer ' +
        'printed it.',
    )
  }
  return { ok: true, value }
}

function readFieldKey(
  tool: string,
  args: Record<string, unknown>,
): Fail | { ok: true; value: string } {
  const raw = readString(tool, args, 'field_key', true)
  if (!raw.ok) return raw
  const value = raw.value as string
  if (!SAFE_TOKEN.test(value)) {
    return fail(
      `${tool} "field_key" must be the field key as boards_describe prints ` +
        'it (letters, digits, underscore or hyphen), not the label.',
    )
  }
  return { ok: true, value }
}

/**
 * The `table` argument as a PATH segment for the table lifecycle ops. A table
 * id or its exact name are both legal, so the segment is percent-encoded
 * downstream rather than pattern-matched; but "." / ".." survive encoding and
 * URL normalization then collapses them, so refuse those and any slash before
 * the value can address something other than one of this board's tables. Same
 * wall as `readBoard`, applied to `table`.
 */
function readTablePathSeg(
  tool: string,
  args: Record<string, unknown>,
): Fail | { ok: true; value: string } {
  const raw = readString(tool, args, 'table', true)
  if (!raw.ok) return raw
  const value = raw.value as string
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    return fail(
      `${tool} "table" must be a table id or its exact name, not a path. ` +
        '"." and ".." and anything containing a slash are refused. Call ' +
        'boards_describe to see the tables on this board.',
    )
  }
  return { ok: true, value }
}

// ── Filter / sort compilation ────────────────────────────────────────────────

/**
 * The shorthand `{ "Status": "Pending" }` compiles to the same condition list
 * the app's filter builder produces, so a filter an agent sends and a filter a
 * human built are indistinguishable downstream. Field labels are left as sent:
 * the backend resolves label or key against the board's own fields.
 */
export function compileFilter(
  input: unknown,
): { ok: true; conditions: BoardsCondition[] } | Fail {
  if (input === undefined || input === null) return { ok: true, conditions: [] }

  if (Array.isArray(input)) {
    const conditions: BoardsCondition[] = []
    for (const [i, raw] of input.entries()) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return fail(`filter[${i}] must be a condition object.`)
      }
      const item = raw as Record<string, unknown>
      const allowed = ['id', 'fieldKey', 'op', 'values', 'dateMod']
      const unknown = Object.keys(item).filter((k) => !allowed.includes(k))
      if (unknown.length) {
        return fail(
          `filter[${i}] does not take ${unknown.map((k) => `"${k}"`).join(', ')}. ` +
            `A condition takes: ${allowed.join(', ')}.`,
        )
      }
      const fieldKey = item.fieldKey
      if (typeof fieldKey !== 'string' || !fieldKey.trim()) {
        return fail(`filter[${i}] needs "fieldKey": a field key or its label.`)
      }
      const op = item.op
      if (typeof op !== 'string' || !OPS.includes(op as (typeof OPS)[number])) {
        return fail(
          `filter[${i}] "op" must be one of ${OPS.join(', ')}, got ` +
            `${JSON.stringify(op)}.`,
        )
      }
      let values: string[] = []
      if (item.values !== undefined && item.values !== null) {
        if (!Array.isArray(item.values)) {
          return fail(`filter[${i}] "values" must be an array of strings.`)
        }
        for (const v of item.values) {
          if (typeof v !== 'string') {
            return fail(`filter[${i}] "values" must be an array of strings.`)
          }
          values.push(v)
        }
      }
      let dateMod: string | undefined
      if (item.dateMod !== undefined && item.dateMod !== null) {
        if (
          typeof item.dateMod !== 'string' ||
          !DATE_MODS.includes(item.dateMod as (typeof DATE_MODS)[number])
        ) {
          return fail(
            `filter[${i}] "dateMod" must be one of ${DATE_MODS.join(', ')}.`,
          )
        }
        dateMod = item.dateMod
      }
      const id =
        typeof item.id === 'string' && item.id.trim() ? item.id : `c${i + 1}`
      conditions.push(
        dateMod === undefined
          ? { id, fieldKey, op, values }
          : { id, fieldKey, op, values, dateMod },
      )
    }
    return { ok: true, conditions }
  }

  if (typeof input === 'object') {
    const conditions: BoardsCondition[] = []
    for (const [i, [key, value]] of Object.entries(
      input as Record<string, unknown>,
    ).entries()) {
      if (typeof value !== 'string') {
        return fail(
          `filter "${key}" must be a string. The shorthand filter matches one ` +
            'exact value per field; for anything else send the full condition ' +
            'list.',
        )
      }
      conditions.push({ id: `c${i + 1}`, fieldKey: key, op: 'is', values: [value] })
    }
    return { ok: true, conditions }
  }

  return fail(
    'filter must be either a map of field to exact value, for example ' +
      '{"Status": "Pending"}, or a list of conditions.',
  )
}

function compileSorts(
  input: unknown,
): { ok: true; sorts: BoardsSortRule[] } | Fail {
  if (input === undefined || input === null) return { ok: true, sorts: [] }
  if (!Array.isArray(input)) {
    return fail('sort must be an array of { fieldKey, dir } rules.')
  }
  const sorts: BoardsSortRule[] = []
  for (const [i, raw] of input.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return fail(`sort[${i}] must be a { fieldKey, dir } rule.`)
    }
    const item = raw as Record<string, unknown>
    const allowed = ['id', 'fieldKey', 'dir']
    const unknown = Object.keys(item).filter((k) => !allowed.includes(k))
    if (unknown.length) {
      return fail(
        `sort[${i}] does not take ${unknown.map((k) => `"${k}"`).join(', ')}. ` +
          `A sort rule takes: ${allowed.join(', ')}.`,
      )
    }
    if (typeof item.fieldKey !== 'string' || !item.fieldKey.trim()) {
      return fail(`sort[${i}] needs "fieldKey".`)
    }
    if (item.dir !== 'asc' && item.dir !== 'desc') {
      return fail(
        `sort[${i}] "dir" must be asc or desc, got ${JSON.stringify(item.dir)}.`,
      )
    }
    const id = typeof item.id === 'string' && item.id.trim() ? item.id : `s${i + 1}`
    sorts.push({ id, fieldKey: item.fieldKey, dir: item.dir })
  }
  return { ok: true, sorts }
}

function compileFieldSpec(
  tool: string,
  raw: unknown,
  where: string,
): { ok: true; field: Record<string, unknown> } | Fail {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(
      `${tool} ${where} must be a field object, for example ` +
        '{ "label": "Owner agent", "type": "agent" }.',
    )
  }
  const item = raw as Record<string, unknown>
  const allowed = ['label', 'type', 'options', 'option_tones', 'description', 'width']
  const unknown = Object.keys(item).filter((k) => !allowed.includes(k))
  if (unknown.length) {
    return fail(
      `${tool} ${where} does not take ${unknown.map((k) => `"${k}"`).join(', ')}. ` +
        `A field takes: ${allowed.join(', ')}.`,
    )
  }
  const label = readString(tool, item, 'label', true)
  if (!label.ok) return label
  const type = readEnum(tool, item, 'type', FIELD_TYPES, true)
  if (!type.ok) return type
  const options = readStringArray(tool, item, 'options', false)
  if (!options.ok) return options
  const tones = readTones(tool, item, 'option_tones')
  if (!tones.ok) return tones
  const description = readString(tool, item, 'description', false)
  if (!description.ok) return description
  const width = readInt(tool, item, 'width', 40, 800, false)
  if (!width.ok) return width

  if ((options.value || tones.value) && type.value !== 'select') {
    return fail(
      `${tool} ${where}: options and option_tones only apply to a select ` +
        `field, and this one is ${type.value}.`,
    )
  }

  const field: Record<string, unknown> = { label: label.value, type: type.value }
  if (options.value) field.options = options.value
  if (tones.value) field.optionTones = tones.value
  if (description.value) field.description = description.value
  if (width.value !== undefined) field.width = width.value
  return { ok: true, field }
}

// ── Responses ────────────────────────────────────────────────────────────────

export function renderBoardsResponse(
  data: unknown,
  format: 'markdown' | 'json',
): string {
  if (format === 'json') return JSON.stringify(data ?? {}, null, 2)
  if (typeof data === 'string') return data
  if (data && typeof data === 'object') {
    const md = (data as Record<string, unknown>).markdown
    if (typeof md === 'string') return md
    // A write that answered 204, or any success with nothing to render. The
    // call landed; a bare "{}" would read like a failure to the model.
    if (!Array.isArray(data) && Object.keys(data).length === 0) return 'Done.'
  }
  if (data === null || data === undefined) return 'Done.'
  return JSON.stringify(data, null, 2)
}

/**
 * The backend's 404 / 403 bodies ARE the contract: a real-but-ungranted board
 * answers byte for byte the same as one that never existed. bgosGet/bgosPost
 * wrap them as `GET 404: <body>`, so peel the prefix and hand the model the
 * body untouched. Anything that is not a JSON error body (a transport failure,
 * say) is reported as it came, never dressed up as a denial.
 */
export function extractBackendErrorBody(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const match = /^(?:GET|POST|PATCH|PUT|DELETE) \d{3}: ([\s\S]*)$/.exec(raw)
  const candidates = match ? [match[1] as string, raw] : [raw]
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && 'error' in parsed) return trimmed
    } catch {
      // not the JSON body, fall through
    }
  }
  return raw
}

// ── Transports ───────────────────────────────────────────────────────────────

interface BoardsResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

type BoardsFetch = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
    // Added by the shared deadline wrapper (lib/bounded-fetch.ts). Declared
    // here so a real fetch receives it and a test fake may ignore it.
    signal?: AbortSignal
  },
) => Promise<BoardsResponse>

/**
 * Fallback deadline when the caller does not pass one. Board answers are
 * paginated tables, never bulk exports, so 30s is far above any healthy
 * answer and still finite.
 */
const BOARDS_DEFAULT_TIMEOUT_MS = 30_000

export interface BoardsTransportOptions {
  /** e.g. https://host/api/v1 */
  apiBase: string
  /** Fresh auth headers per call (pairing or api key). */
  headers: () => Record<string, string>
  fetchImpl?: BoardsFetch
  maxBytes?: number
  /**
   * Deadline for a whole board call, headers plus body. Omitted in tests
   * (their fakes answer instantly); server.ts passes the daemon's ordinary
   * HTTP bound so no board tool can hang the session forever.
   */
  timeoutMs?: number
  log?: (msg: string) => void
}

/**
 * Boards gets its OWN transports rather than reusing the shared plugin ones,
 * for two reasons that both bite the model directly:
 *
 *  1. The shared helpers cut an error body at 200 chars. The denial bodies are
 *     the contract and the ambiguous-board error carries name (id) pairs, so a
 *     cut body reaches the model as invalid JSON. Here the body survives to
 *     BOARDS_ERROR_BODY_MAX_CHARS.
 *  2. The shared helpers call response.json() unconditionally, which throws on
 *     an empty body. A 204 on a write that already succeeded would be reported
 *     to the model as a failure, and the model would retry a write that landed.
 *     Here an empty or non-JSON success body is simply {}.
 *
 * The shared helpers are left exactly as they are for every other tool.
 */
export function createBoardsTransports(
  opts: BoardsTransportOptions,
): Required<Pick<BoardsToolDeps, 'bgosGet' | 'bgosPost' | 'bgosPatch' | 'bgosDelete'>> {
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as BoardsFetch)
  const maxBytes = opts.maxBytes ?? BOARDS_RESPONSE_MAX_BYTES
  const base = opts.apiBase.replace(/\/$/, '')

  const call = async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> => {
    const headers: Record<string, string> = { ...opts.headers() }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    // The whole call runs under one deadline (headers AND body) so the
    // content-length guard below still runs before anything is read.
    return boundedFetch<unknown, BoardsResponse>(
      {
        url: `${base}/${path.replace(/^\//, '')}`,
        init: {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
        timeoutMs: opts.timeoutMs ?? BOARDS_DEFAULT_TIMEOUT_MS,
        label: `${method} ${path}`,
      },
      async (response) => {
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new Error(
            `${method} ${response.status}: ${text.slice(0, BOARDS_ERROR_BODY_MAX_CHARS)}`,
          )
        }
        const declared = Number(response.headers.get('content-length') ?? '')
        if (Number.isFinite(declared) && declared > maxBytes) {
          throw new Error(
            `${method} ${path}: the board answer is too large (${declared} bytes). ` +
              'Narrow it with a filter or a smaller limit.',
          )
        }
        const text = await response.text().catch(() => '')
        if (!text.trim()) return {}
        try {
          return JSON.parse(text) as unknown
        } catch {
          // A success the backend did not send as JSON. The write landed; say
          // so rather than turning it into a failure the model would retry.
          return {}
        }
      },
      { fetchImpl: doFetch, log: opts.log },
    )
  }

  return {
    bgosGet: (path) => call('GET', path),
    bgosPost: (path, body) => call('POST', path, body ?? {}),
    bgosPatch: (path, body) => call('PATCH', path, body ?? {}),
    bgosDelete: (path) => call('DELETE', path),
  }
}

function ok(text: string): BoardsToolResult {
  return { content: [{ type: 'text', text }] }
}

function errorResult(text: string): BoardsToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

// ── Attachment bytes ─────────────────────────────────────────────────────────

function tooBig(tool: string, bytes: number): Fail {
  return fail(
    `${tool} file is ${Math.round(bytes / 1024 / 1024)} MB, over the ` +
      `${MAX_ATTACH_BYTES / 1024 / 1024} MB limit. Attach a smaller file or ` +
      'a link to it.',
  )
}

async function resolveAttachmentBytes(
  tool: string,
  args: Record<string, unknown>,
):
  | Promise<
      | { ok: true; bytes: Uint8Array; base64: string; name: string; mime: string }
      | Fail
    > {
  const filePath = readString(tool, args, 'file_path', false)
  if (!filePath.ok) return filePath
  const contentB64 = readString(tool, args, 'content_base64', false)
  if (!contentB64.ok) return contentB64
  const explicitName = readString(tool, args, 'name', false)
  if (!explicitName.ok) return explicitName
  const explicitMime = readString(tool, args, 'mime', false)
  if (!explicitMime.ok) return explicitMime

  if (filePath.value && contentB64.value) {
    return fail(
      `${tool} takes either "file_path" or "content_base64", not both. ` +
        'Send the path when the file is on this machine.',
    )
  }
  if (!filePath.value && !contentB64.value) {
    return fail(
      `${tool} needs the file: either "file_path" (a path on this machine) ` +
        'or "content_base64" together with "name".',
    )
  }

  let bytes: Uint8Array
  let base64: string
  let name: string

  if (filePath.value) {
    // stat BEFORE read: reading first would pull a multi-gigabyte path into
    // the daemon's memory just to find out it is over the cap.
    let onDisk: number
    try {
      const info = await stat(filePath.value)
      if (!info.isFile()) {
        return fail(`${tool} "${filePath.value}" is not a file.`)
      }
      onDisk = info.size
    } catch (err) {
      return fail(
        `${tool} could not read "${filePath.value}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (onDisk > MAX_ATTACH_BYTES) return tooBig(tool, onDisk)
    try {
      const buf = await readFile(filePath.value)
      bytes = new Uint8Array(buf)
      base64 = Buffer.from(buf).toString('base64')
    } catch (err) {
      return fail(
        `${tool} could not read "${filePath.value}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
    name = explicitName.value || basename(filePath.value)
  } else {
    if (!explicitName.value) {
      return fail(`${tool} needs "name" when you send "content_base64".`)
    }
    base64 = contentB64.value as string
    // 4 base64 chars carry 3 bytes: size the decode before doing it.
    const estimated = Math.floor((base64.length * 3) / 4)
    if (estimated > MAX_ATTACH_BYTES) return tooBig(tool, estimated)
    const buf = Buffer.from(base64, 'base64')
    if (!buf.length) {
      return fail(`${tool} "content_base64" did not decode to any bytes.`)
    }
    bytes = new Uint8Array(buf)
    name = explicitName.value
  }

  if (bytes.length > MAX_ATTACH_BYTES) return tooBig(tool, bytes.length)

  const mime =
    explicitMime.value ||
    guessOutboundMime(filePath.value ?? '', name, null) ||
    'application/octet-stream'

  return { ok: true, bytes, base64, name, mime }
}

/**
 * The presigned attachment PUT. Bounded like every other call the daemon
 * makes, and on the SAME shared deadline as the message-file upload in
 * server.ts: this one was missed when the boards transports were bounded, and
 * it was the last unbounded `await fetch` on the daemon surface.
 *
 * The label deliberately does not include the url: it is a presigned S3 link
 * and carries a signature.
 */
async function defaultPutBytes(
  url: string,
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  await boundedFetch<void, BoardsResponse>(
    {
      url,
      init: {
        method: 'PUT',
        headers: { 'Content-Type': mime },
        body: bytes as unknown as BodyInit,
      },
      timeoutMs: UPLOAD_DEADLINE_MS,
      label: `PUT board attachment (${bytes.length} bytes)`,
    },
    async (response) => {
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`PUT ${response.status}: ${text.slice(0, 200)}`)
      }
    },
  )
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * One entry point for all 12 tools. server.ts routes every name starting with
 * `boards_` here, so the family stays in one testable place.
 */
export async function handleBoardsTool(
  name: string,
  rawArgs: unknown,
  deps: BoardsToolDeps,
): Promise<BoardsToolResult> {
  const allowed = ALLOWED_ARGS[name]
  if (!allowed) {
    return errorResult(
      `Unknown tool "${name}". The board tools are: ` +
        `${BOARDS_TOOL_DECLS.map((d) => d.name).join(', ')}.`,
    )
  }

  if (rawArgs !== undefined && rawArgs !== null) {
    if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      return errorResult(`${name} arguments must be an object.`)
    }
  }
  const args = (rawArgs ?? {}) as Record<string, unknown>

  const unknownArgs = Object.keys(args).filter(
    (k) => !allowed.includes(k) && args[k] !== undefined,
  )
  if (unknownArgs.length) {
    return errorResult(
      `${name} does not take ${unknownArgs.map((k) => `"${k}"`).join(', ')}. ` +
        (allowed.length
          ? `Allowed arguments: ${allowed.join(', ')}.`
          : 'It takes no arguments.') +
        ' Call boards_describe if you are unsure about a board\'s shape.',
    )
  }

  const format = readEnum(name, args, 'response_format', ['markdown', 'json'], false)
  if (!format.ok) return errorResult(format.error)
  const fmt = (format.value ?? 'markdown') as 'markdown' | 'json'

  try {
    const built = await buildCall(name, args, deps, fmt)
    if (!built.ok) return errorResult(built.error)
    return ok(renderBoardsResponse(built.data, fmt))
  } catch (err) {
    return errorResult(extractBackendErrorBody(err))
  }
}

async function buildCall(
  name: string,
  args: Record<string, unknown>,
  deps: BoardsToolDeps,
  fmt: 'markdown' | 'json',
): Promise<{ ok: true; data: unknown } | Fail> {
  const base = boardsBase(deps.assistantId)

  // boards_list is the only tool that does not name a board.
  if (name === 'boards_list') {
    return { ok: true, data: await deps.bgosGet(`${base}?format=${fmt}`) }
  }

  if (name === 'boards_create') {
    const boardName = readString(name, args, 'name', true)
    if (!boardName.ok) return boardName
    const description = readString(name, args, 'description', false)
    if (!description.ok) return description
    const body: Record<string, unknown> = { name: boardName.value }
    if (description.value) body.description = description.value
    if (args.fields !== undefined && args.fields !== null) {
      if (!Array.isArray(args.fields)) {
        return wrongType(name, 'fields', 'an array of field objects', args.fields)
      }
      const fields: Array<Record<string, unknown>> = []
      for (const [i, raw] of args.fields.entries()) {
        const spec = compileFieldSpec(name, raw, `fields[${i}]`)
        if (!spec.ok) return spec
        fields.push(spec.field)
      }
      body.fields = fields
    }
    return { ok: true, data: await deps.bgosPost(base, body) }
  }

  const board = readBoard(name, args)
  if (!board.ok) return board
  const boardSeg = board.value

  switch (name) {
    case 'boards_describe': {
      const path = boardPath(deps, boardSeg, `/describe?format=${fmt}`)
      return { ok: true, data: await deps.bgosGet(path) }
    }

    case 'boards_update_schema':
      return updateSchema(name, args, deps, boardSeg)

    case 'boards_query': {
      const conditions = compileFilter(args.filter)
      if (!conditions.ok) return fail(`${name} ${conditions.error}`)
      const sorts = compileSorts(args.sort)
      if (!sorts.ok) return fail(`${name} ${sorts.error}`)
      const conjunction = readEnum(name, args, 'conjunction', ['and', 'or'], false)
      if (!conjunction.ok) return conjunction
      const search = readString(name, args, 'search', false)
      if (!search.ok) return search
      const limit = readInt(name, args, 'limit', 1, MAX_LIMIT, false)
      if (!limit.ok) return limit
      const cursor = readString(name, args, 'cursor', false)
      if (!cursor.ok) return cursor
      // The table rides the query string, name-or-id, resolved server-side.
      const table = readString(name, args, 'table', false)
      if (!table.ok) return table

      const body: Record<string, unknown> = {}
      if (args.filter !== undefined && args.filter !== null) {
        body.conditions = conditions.conditions
      }
      if (conjunction.value) body.conjunction = conjunction.value
      if (sorts.sorts.length) body.sorts = sorts.sorts
      if (search.value) body.search = search.value
      if (limit.value !== undefined) body.limit = limit.value
      if (cursor.value) body.cursor = cursor.value

      const tableQs = table.value
        ? `&table=${encodeURIComponent(table.value)}`
        : ''
      const path = boardPath(
        deps,
        boardSeg,
        `/rows/query?format=${fmt}${tableQs}`,
      )
      return { ok: true, data: await deps.bgosPost(path, body) }
    }

    case 'boards_get_row': {
      const rowKey = readRowKey(name, args)
      if (!rowKey.ok) return rowKey
      const path = boardPath(
        deps,
        boardSeg,
        `/rows/${encodeURIComponent(rowKey.value)}?format=${fmt}`,
      )
      return { ok: true, data: await deps.bgosGet(path) }
    }

    case 'boards_insert': {
      const cells = readStringMap(name, args, 'cells', true)
      if (!cells.ok) return cells
      // The table rides the query string, name-or-id, resolved server-side.
      const table = readString(name, args, 'table', false)
      if (!table.ok) return table
      const suffix = table.value
        ? `/rows?table=${encodeURIComponent(table.value)}`
        : '/rows'
      const path = boardPath(deps, boardSeg, suffix)
      return { ok: true, data: await deps.bgosPost(path, { cells: cells.value }) }
    }

    case 'boards_update': {
      const rowKey = readRowKey(name, args)
      if (!rowKey.ok) return rowKey
      const cells = readStringMap(name, args, 'cells', true)
      if (!cells.ok) return cells
      const path = boardPath(
        deps,
        boardSeg,
        `/rows/${encodeURIComponent(rowKey.value)}`,
      )
      return { ok: true, data: await deps.bgosPatch(path, { cells: cells.value }) }
    }

    case 'boards_attach':
      return attach(name, args, deps, boardSeg)

    case 'boards_search': {
      const query = readString(name, args, 'query', true)
      if (!query.ok) return query
      const limit = readInt(name, args, 'limit', 1, MAX_SEARCH_LIMIT, false)
      if (!limit.ok) return limit
      const body: Record<string, unknown> = { query: query.value }
      if (limit.value !== undefined) body.limit = limit.value
      const path = boardPath(deps, boardSeg, `/search?format=${fmt}`)
      return { ok: true, data: await deps.bgosPost(path, body) }
    }

    case 'boards_changes': {
      const since = readString(name, args, 'since', false)
      if (!since.ok) return since
      const suffix =
        `/changes?format=${fmt}` +
        (since.value ? `&since=${encodeURIComponent(since.value)}` : '')
      return { ok: true, data: await deps.bgosGet(boardPath(deps, boardSeg, suffix)) }
    }

    case 'boards_grant': {
      const assistantId = readInt(name, args, 'assistant_id', 1, 2 ** 31, true)
      if (!assistantId.ok) return assistantId
      const role = readEnum(name, args, 'role', ROLES, true)
      if (!role.ok) return role
      const path = boardPath(deps, boardSeg, '/grants')
      return {
        ok: true,
        data: await deps.bgosPost(path, {
          assistantId: assistantId.value,
          role: role.value,
        }),
      }
    }

    default:
      return fail(`Unknown tool "${name}".`)
  }
}

const SCHEMA_OP_ARGS: Record<string, { needs: string[]; optional: string[] }> = {
  add_field: { needs: ['field'], optional: [] },
  rename_field: { needs: ['field_key', 'label'], optional: [] },
  delete_field: { needs: ['field_key'], optional: [] },
  set_description: { needs: ['field_key', 'description'], optional: [] },
  set_options: { needs: ['field_key', 'options'], optional: ['option_tones', 'option_renames'] },
  // Kanban phase 1: a separate op, not a key on set_options, because that op
  // needs the FULL option list and every sentence would resend it.
  set_column_lines: { needs: ['field_key', 'lines'], optional: ['clear_lines', 'workflow'] },
  move_field: { needs: ['field_key', 'position'], optional: [] },
  // Table lifecycle. `label` carries the table name (new table, or the new
  // name on a rename); `table` names the existing table to act on.
  add_table: { needs: ['label'], optional: [] },
  rename_table: { needs: ['table', 'label'], optional: [] },
  move_table: { needs: ['table', 'position'], optional: [] },
  delete_table: { needs: ['table'], optional: [] },
}

async function updateSchema(
  name: string,
  args: Record<string, unknown>,
  deps: BoardsToolDeps,
  boardSeg: string,
): Promise<{ ok: true; data: unknown } | Fail> {
  const op = readEnum(name, args, 'op', SCHEMA_OPS, true)
  if (!op.ok) return op
  const spec = SCHEMA_OP_ARGS[op.value as string]!

  const usable = new Set(['board', 'op', ...spec.needs, ...spec.optional])
  const stray = Object.keys(args).filter(
    (k) => !usable.has(k) && args[k] !== undefined,
  )
  if (stray.length) {
    return fail(
      `${name} op "${op.value}" does not use ` +
        `${stray.map((k) => `"${k}"`).join(', ')}. It takes: ` +
        `${[...spec.needs, ...spec.optional].join(', ')}.`,
    )
  }
  for (const need of spec.needs) {
    if (args[need] === undefined || args[need] === null || args[need] === '') {
      return missing(`${name} op "${op.value}"`, need)
    }
  }

  if (op.value === 'add_field') {
    const field = compileFieldSpec(name, args.field, '"field"')
    if (!field.ok) return field
    const path = boardPath(deps, boardSeg, '/fields')
    return { ok: true, data: await deps.bgosPost(path, field.field) }
  }

  // Table lifecycle ops address the /tables collection and never a field_key.
  if (
    op.value === 'add_table' ||
    op.value === 'rename_table' ||
    op.value === 'move_table' ||
    op.value === 'delete_table'
  ) {
    return updateTables(name, args, deps, boardSeg, op.value)
  }

  const fieldKey = readFieldKey(name, args)
  if (!fieldKey.ok) return fieldKey
  const fieldPath = boardPath(
    deps,
    boardSeg,
    `/fields/${encodeURIComponent(fieldKey.value)}`,
  )

  if (op.value === 'delete_field') {
    if (!deps.bgosDelete) {
      return fail(`${name} cannot delete a field on this connection.`)
    }
    return { ok: true, data: await deps.bgosDelete(fieldPath) }
  }

  const body: Record<string, unknown> = {}
  if (op.value === 'rename_field') {
    const label = readString(name, args, 'label', true)
    if (!label.ok) return label
    body.label = label.value
  } else if (op.value === 'set_description') {
    const description = readString(name, args, 'description', true)
    if (!description.ok) return description
    body.description = description.value
  } else if (op.value === 'set_options') {
    const options = readStringArray(name, args, 'options', true)
    if (!options.ok) return options
    const tones = readTones(name, args, 'option_tones')
    if (!tones.ok) return tones
    const renames = readOptionRenames(name, args)
    if (!renames.ok) return renames
    body.options = options.value
    if (tones.value) body.optionTones = tones.value
    if (renames.value?.length) body.optionRenames = renames.value
  } else if (op.value === 'set_column_lines') {
    const lines = compileColumnLines(name, args)
    if (!lines.ok) return lines
    return columnLinesAnswer(await deps.bgosPatch(fieldPath, lines.body))
  } else if (op.value === 'move_field') {
    const position = readInt(name, args, 'position', 0, 200, true)
    if (!position.ok) return position
    body.position = position.value
  }

  return { ok: true, data: await deps.bgosPatch(fieldPath, body) }
}

/**
 * The four table lifecycle ops (multi-table boards), folded under update_schema.
 * `add_table` names no existing table; the others resolve `table` server-side
 * (a table id, or a name that fails closed with the tables that DO exist).
 *
 * The per-op required arguments are already enforced by SCHEMA_OP_ARGS in
 * updateSchema, so a missing name or table is caught there before this runs.
 */
async function updateTables(
  name: string,
  args: Record<string, unknown>,
  deps: BoardsToolDeps,
  boardSeg: string,
  op: string,
): Promise<{ ok: true; data: unknown } | Fail> {
  // add_table creates a table; `label` carries its name. No table segment.
  if (op === 'add_table') {
    const label = readString(name, args, 'label', true)
    if (!label.ok) return label
    const path = boardPath(deps, boardSeg, '/tables')
    return { ok: true, data: await deps.bgosPost(path, { name: label.value }) }
  }

  const table = readTablePathSeg(name, args)
  if (!table.ok) return table
  const tablePath = boardPath(
    deps,
    boardSeg,
    `/tables/${encodeURIComponent(table.value)}`,
  )

  if (op === 'delete_table') {
    if (!deps.bgosDelete) {
      return fail(`${name} cannot delete a table on this connection.`)
    }
    return { ok: true, data: await deps.bgosDelete(tablePath) }
  }

  if (op === 'rename_table') {
    const label = readString(name, args, 'label', true)
    if (!label.ok) return label
    return { ok: true, data: await deps.bgosPatch(tablePath, { name: label.value }) }
  }

  // move_table
  const position = readInt(name, args, 'position', 0, 1000, true)
  if (!position.ok) return position
  return { ok: true, data: await deps.bgosPatch(tablePath, { position: position.value }) }
}

async function attach(
  name: string,
  args: Record<string, unknown>,
  deps: BoardsToolDeps,
  boardSeg: string,
): Promise<{ ok: true; data: unknown } | Fail> {
  const rowKey = readRowKey(name, args)
  if (!rowKey.ok) return rowKey
  const fieldKeyRaw = readString(name, args, 'field_key', false)
  if (!fieldKeyRaw.ok) return fieldKeyRaw
  if (fieldKeyRaw.value && !SAFE_TOKEN.test(fieldKeyRaw.value)) {
    return fail(
      `${name} "field_key" must be the attachment field key as ` +
        'boards_describe prints it.',
    )
  }

  const file = await resolveAttachmentBytes(name, args)
  if (!file.ok) return file

  const attachPath = boardPath(
    deps,
    boardSeg,
    `/rows/${encodeURIComponent(rowKey.value)}/attachments`,
  )
  const meta: Record<string, unknown> = {
    name: file.name,
    mime: file.mime,
    size: file.bytes.length,
  }
  if (fieldKeyRaw.value) meta.field_key = fieldKeyRaw.value

  // Small files ride inline. Bigger ones take the presigned route so the
  // bytes never pass through the API process.
  if (file.bytes.length <= INLINE_ATTACH_BYTES) {
    meta.content_base64 = file.base64
    return { ok: true, data: await deps.bgosPost(attachPath, meta) }
  }

  const created = (await deps.bgosPost(attachPath, meta)) as {
    attachmentId?: string
    uploadUrl?: string
  } | null
  const uploadUrl = created?.uploadUrl
  const attachmentId = created?.attachmentId
  if (!uploadUrl || !attachmentId) {
    return fail(
      `${name} did not get an upload url back for "${file.name}". ` +
        'Retry, or attach a file under 1 MB.',
    )
  }
  // The file bytes are about to leave this machine to whatever host that url
  // names. Only over TLS, and only over a scheme that is actually an upload:
  // a plaintext or file: url would leak the owner's data or read local disk.
  let parsedUpload: URL
  try {
    parsedUpload = new URL(uploadUrl)
  } catch {
    return fail(`${name} got an upload url it cannot parse. Nothing was sent.`)
  }
  if (parsedUpload.protocol !== 'https:') {
    return fail(
      `${name} refused to upload "${file.name}": the upload url is ` +
        `${parsedUpload.protocol}//, and file bytes only travel over https. ` +
        'Nothing was sent.',
    )
  }
  const put = deps.putBytes ?? defaultPutBytes
  await put(uploadUrl, file.bytes, file.mime)
  const completePath = boardPath(
    deps,
    boardSeg,
    `/attachments/${encodeURIComponent(attachmentId)}/complete`,
  )
  return { ok: true, data: await deps.bgosPost(completePath, {}) }
}
