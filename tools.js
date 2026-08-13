'use strict';

// Canonical, provider-neutral tool definitions and their execution.
// Providers translate `definitions` into their own wire format; the server
// runs the tools via run(). Add a tool by extending both.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASH_TIMEOUT_MS = 30000;

const definitions = [
  {
    name: 'bash',
    description: 'Run a shell command and return stdout/stderr.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The bash command to run.' } },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the filesystem.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute or relative path to the file.' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to write to.' },
        content: { type: 'string', description: 'Content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description: 'List directory contents.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path.' } },
      required: ['path'],
    },
  },
];

// Execute a tool by name. Always resolves (never rejects) with a plain
// result object so the harness can feed it straight back to the model.
function run(name, input) {
  input = input || {};
  if (name === 'bash') return runBash(input.command || '');
  if (name === 'read_file') return runReadFile(input.path || '');
  if (name === 'write_file') return runWriteFile(input.path || '', input.content || '');
  if (name === 'list_dir') return runListDir(input.path || '.');
  return Promise.resolve({ error: 'Unknown tool: ' + name });
}

function runBash(command) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { timeout: BASH_TIMEOUT_MS });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ stdout, stderr, exit_code: code }));
    child.on('error', (e) => resolve({ stdout: '', stderr: e.message, exit_code: 1 }));
  });
}

async function runReadFile(p) {
  try { return { content: await fs.promises.readFile(path.resolve(p), 'utf8') }; }
  catch (e) { return { error: e.message }; }
}

async function runWriteFile(p, content) {
  try { await fs.promises.writeFile(path.resolve(p), content, 'utf8'); return { ok: true }; }
  catch (e) { return { error: e.message }; }
}

async function runListDir(p) {
  try {
    const entries = await fs.promises.readdir(path.resolve(p), { withFileTypes: true });
    return { entries: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) };
  } catch (e) { return { error: e.message }; }
}

module.exports = { definitions, run };
