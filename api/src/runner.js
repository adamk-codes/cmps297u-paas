import { spawn } from 'node:child_process'

// Runs a short command and captures its output (e.g. kubectl ... -o json).
export function runCapture(command, args, { env = {}, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

const RESULT_LINE = /^([A-Z]+_RESULT) (\{.*\})\s*$/
const STEP_LINE = /(?:\[([a-z-]+)\]|::step ([a-z-]+))/

// Runs a data script and reports progress. Scripts log to stderr as "... [step] message" or
// "... ::step <name>", and print "<KIND>_RESULT {json}" on stdout when they finish.
// Resolves with { code, results, logTail }; never rejects for a non-zero exit.
export function runScript({ command, args = [], env = {}, timeoutMs = 25 * 60 * 1000, onStep, onLog }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const results = {}
    const tail = []
    const remember = (line) => {
      tail.push(line)
      if (tail.length > 40) tail.shift()
      onLog?.(line)
    }

    const lines = (stream, handle) => {
      let buf = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => {
        buf += chunk
        let i
        while ((i = buf.indexOf('\n')) !== -1) {
          handle(buf.slice(0, i).replace(/\r$/, ''))
          buf = buf.slice(i + 1)
        }
      })
      stream.on('end', () => buf && handle(buf))
    }

    const handle = (line) => {
      const result = line.match(RESULT_LINE)
      if (result) {
        try {
          results[result[1]] = JSON.parse(result[2])
        } catch {
          /* not JSON after all; keep as a log line */
        }
        return
      }
      const step = line.match(STEP_LINE)
      if (step) onStep?.(step[1] || step[2])
      if (line.trim()) remember(line)
    }
    lines(child.stdout, handle)
    lines(child.stderr, handle)

    const timer = setTimeout(() => {
      remember(`timed out after ${Math.round(timeoutMs / 1000)}s`)
      child.kill('SIGTERM')
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, results, logTail: tail })
    })
  })
}
