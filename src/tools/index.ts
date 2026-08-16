/**
 * Built-in tools for the coding agent: read, write, edit, bash.
 *
 * Each tool is a self-contained `Tool` with a JSON schema for its arguments
 * and an `execute` that performs the side effect and returns a text result.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import type { Tool } from '../types.js'

const execFileAsync = promisify(execFile)

/** Cap tool output so a single call cannot flood the model's context. */
const READ_MAX_CHARS = 64 * 1024

/** Default shell command timeout, in seconds. */
const BASH_DEFAULT_TIMEOUT_S = 120
const BASH_MAX_TIMEOUT_S = 600

/** Read a file's contents, truncated to READ_MAX_CHARS. */
export const readTool: Tool = {
  name: 'read',
  description: 'Read the contents of a file (truncated beyond 64 KiB).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to read.' },
    },
    required: ['path'],
  },
  async execute(args) {
    const path = String(args.path)
    try {
      const content = await readFile(path, 'utf8')
      if (content.length <= READ_MAX_CHARS) return content
      return (
        content.slice(0, READ_MAX_CHARS) +
        `\n... (truncated: showing the first ${READ_MAX_CHARS} of ${content.length} characters)`
      )
    } catch (error) {
      return `error reading ${path}: ${(error as Error).message}`
    }
  },
}

/** Write a file, overwriting any existing content. */
export const writeTool: Tool = {
  name: 'write',
  description: 'Write content to a file, overwriting it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to write.' },
      content: { type: 'string', description: 'The full content to write.' },
    },
    required: ['path', 'content'],
  },
  async execute(args) {
    const path = String(args.path)
    const content = String(args.content)
    try {
      await writeFile(path, content, 'utf8')
      return `wrote ${path} (${content.length} bytes)`
    } catch (error) {
      return `error writing ${path}: ${(error as Error).message}`
    }
  },
}

/** Apply a string replacement to a file. The match must be unique. */
export const editTool: Tool = {
  name: 'edit',
  description: 'Replace an exact string in a file with a new string. The old_string must appear exactly once.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit.' },
      old_string: { type: 'string', description: 'The exact text to find.' },
      new_string: { type: 'string', description: 'The replacement text.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(args) {
    const path = String(args.path)
    const oldString = String(args.old_string)
    const newString = String(args.new_string)
    try {
      const content = await readFile(path, 'utf8')
      const matches = content.split(oldString).length - 1
      if (matches === 0) {
        return `error: old_string not found in ${path}`
      }
      if (matches > 1) {
        return `error: old_string matches ${matches} times in ${path}; add surrounding context to make it unique`
      }
      const updated = content.replace(oldString, newString)
      await writeFile(path, updated, 'utf8')
      return `edited ${path}`
    } catch (error) {
      return `error editing ${path}: ${(error as Error).message}`
    }
  },
}

/** Run a shell command and capture its output. Commands time out. */
export const bashTool: Tool = {
  name: 'bash',
  description: 'Run a shell command and return its stdout and stderr.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
      cwd: { type: 'string', description: "Working directory; defaults to the agent's working directory." },
      timeout: { type: 'number', description: `Timeout in seconds (default ${BASH_DEFAULT_TIMEOUT_S}, max ${BASH_MAX_TIMEOUT_S}).` },
    },
    required: ['command'],
  },
  async execute(args) {
    const command = String(args.command)
    const cwd = args.cwd ? resolve(String(args.cwd)) : undefined
    const timeoutS = Math.min(
      Math.max(Number(args.timeout ?? BASH_DEFAULT_TIMEOUT_S) || BASH_DEFAULT_TIMEOUT_S, 1),
      BASH_MAX_TIMEOUT_S,
    )
    try {
      const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
        cwd,
        timeout: timeoutS * 1000,
        maxBuffer: 10 * 1024 * 1024,
      })
      const parts = [stdout, stderr].filter(Boolean)
      return parts.join('\n') || '(no output)'
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message: string }
      return `command failed: ${e.message}\n${e.stdout ?? ''}${e.stderr ?? ''}`
    }
  },
}

/** All built-in tools, in the order the model should consider them. */
export const builtinTools: Tool[] = [readTool, writeTool, editTool, bashTool]
