import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

// AgentProfileImageSourceDto, from the backend's published API schema.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const input = z.strictObject({
  path: z.string().min(1).refine(value => isAbsolute(value) && !value.includes('\0'), 'Use an absolute local image file path.'),
})

export const PROFILE_IMAGE_GUIDANCE =
  'When your owner asks you to change your own picture, call set_profile_image with the absolute path of the image file you made. ' +
  'Use PNG, JPEG, WebP or GIF, at most 5 MB. The tool uploads it through your existing HOAI connection and sets only your own picture. ' +
  'Never ask for an API key. If the server refuses, tell your owner the reason and stop.'

export const PROFILE_IMAGE_TOOL = {
  name: 'set_profile_image',
  description: PROFILE_IMAGE_GUIDANCE,
  inputSchema: z.toJSONSchema(input, { target: 'draft-7' }),
}

interface ProfileImageDeps {
  assistantId: string | number
  ownerId: string
  actingUserId: string
  put(path: string, body: Record<string, unknown>, headers: Record<string, string>): Promise<unknown>
}

function imageBytes(bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
    ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')) ||
    (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP')
}

async function readImage(path: string): Promise<Buffer> {
  // Nonblocking open lets a special file be rejected by stat without waiting
  // for a writer. The bounded read also covers a file growing after stat.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('Choose a regular local image file.')
    if (info.size > MAX_IMAGE_BYTES) throw new Error('The picture must be at most 5 MB.')
    const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null)
      if (bytesRead === 0) break
      size += bytesRead
    }
    if (size > MAX_IMAGE_BYTES) throw new Error('The picture must be at most 5 MB.')
    const bytes = buffer.subarray(0, size)
    if (!imageBytes(bytes)) throw new Error('Choose a PNG, JPEG, WebP or GIF image. The type is checked from its bytes.')
    return bytes
  } finally {
    await file.close()
  }
}

export async function handleProfileImage(args: unknown, deps: ProfileImageDeps) {
  const result = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) })
  try {
    const parsed = input.safeParse(args)
    if (!parsed.success) return result('Pass only path, the absolute path of a local PNG, JPEG, WebP or GIF image file, at most 5 MB.', true)
    if (!deps.ownerId || deps.actingUserId !== deps.ownerId) {
      return result('Only your owner can ask you to change your own picture in their own chat.', true)
    }
    const ownId = String(deps.assistantId)
    if (!/^\d+$/.test(ownId) || !Number.isSafeInteger(Number(ownId)) || Number(ownId) <= 0) {
      return result('This connection has no valid agent identity. Nothing was uploaded.', true)
    }
    let bytes: Buffer
    try { bytes = await readImage(parsed.data.path) }
    catch (err) {
      // Filesystem errors contain local paths; the agent already knows the
      // path it supplied, so keep those out of tool output.
      return result(err instanceof Error && !('code' in err) ? err.message : 'The local image file could not be read. Check that it exists and is readable.', true)
    }
    await deps.put(`agent-profile-image/agents/${Number(ownId)}`, { imageBase64: bytes.toString('base64') }, { 'X-Caller-Assistant-Id': String(Number(ownId)) })
    return result('Your own picture was updated.')
  } catch (err) {
    // The existing authenticated client preserves the server's refusal
    // sentence. No retry, alternate route, or credential request follows it.
    return result(err instanceof Error ? err.message : 'The picture could not be updated.', true)
  }
}
